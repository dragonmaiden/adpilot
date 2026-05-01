const postgres = require('./postgres');
const { getOrderCashTotals } = require('../domain/imwebPayments');
const { getPurchases } = require('../domain/metrics');
const { formatDateInTimeZone } = require('../domain/time');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}

function parseDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function getOrderNo(order) {
  const value = order?.orderNo ?? order?.order_no ?? order?.orderCode ?? order?.order_code;
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

async function upsertScanRun(client, scanResult, latestData) {
  await client.query(
    `insert into scan_runs (
      scan_id,
      started_at,
      finished_at,
      status,
      manual,
      source_status,
      stats,
      errors,
      updated_at
    ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, now())
    on conflict (scan_id) do update set
      started_at = excluded.started_at,
      finished_at = excluded.finished_at,
      status = excluded.status,
      manual = excluded.manual,
      source_status = excluded.source_status,
      stats = excluded.stats,
      errors = excluded.errors,
      updated_at = now()`,
    [
      String(scanResult.scanId),
      scanResult.startTime || null,
      scanResult.endTime || null,
      scanResult.status || 'unknown',
      Boolean(scanResult.manual),
      json(scanResult.sourceHealth || latestData.sources || {}),
      json(scanResult.stats || {}),
      json(scanResult.errors || []),
    ]
  );
}

async function upsertImwebOrders(client, scanId, orders) {
  let persisted = 0;

  for (const order of asArray(orders)) {
    const orderNo = getOrderNo(order);
    if (!orderNo) continue;

    const orderedAt = parseDate(order?.wtime);
    const cash = getOrderCashTotals(order);
    await client.query(
      `insert into imweb_orders (
        order_no,
        ordered_at,
        order_date,
        approved_amount,
        refunded_amount,
        raw,
        last_seen_scan_id,
        last_seen_at,
        updated_at
      ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), now())
      on conflict (order_no) do update set
        ordered_at = excluded.ordered_at,
        order_date = excluded.order_date,
        approved_amount = excluded.approved_amount,
        refunded_amount = excluded.refunded_amount,
        raw = excluded.raw,
        last_seen_scan_id = excluded.last_seen_scan_id,
        last_seen_at = now(),
        updated_at = now()`,
      [
        orderNo,
        orderedAt ? orderedAt.toISOString() : null,
        orderedAt ? formatDateInTimeZone(orderedAt) : null,
        Math.round(cash.approvedAmount),
        Math.round(cash.refundedAmount),
        json(order),
        String(scanId),
      ]
    );
    persisted += 1;
  }

  return persisted;
}

function buildRevenueSnapshots(latestData) {
  const dailyRevenue = latestData?.revenueData?.dailyRevenue;
  if (!dailyRevenue || typeof dailyRevenue !== 'object' || Array.isArray(dailyRevenue)) {
    return [];
  }

  return Object.entries(dailyRevenue).map(([date, totals]) => ({
    source: 'imweb_revenue',
    date,
    totals,
  }));
}

function buildCogsSnapshots(latestData) {
  const dailyCogs = latestData?.cogsData?.dailyCOGS;
  if (!dailyCogs || typeof dailyCogs !== 'object' || Array.isArray(dailyCogs)) {
    return [];
  }

  return Object.entries(dailyCogs).map(([date, totals]) => ({
    source: 'cogs',
    date,
    totals,
  }));
}

function buildMetaSnapshots(latestData) {
  const byDate = new Map();

  for (const row of asArray(latestData?.campaignInsights)) {
    const date = row?.date_start;
    if (!date) continue;

    const current = byDate.get(date) || {
      rows: 0,
      spendUsd: 0,
      purchases: 0,
      clicks: 0,
      impressions: 0,
    };
    current.rows += 1;
    current.spendUsd += toNumber(row.spend);
    current.purchases += getPurchases(row.actions);
    current.clicks += toNumber(row.clicks);
    current.impressions += toNumber(row.impressions);
    byDate.set(date, current);
  }

  return [...byDate.entries()].map(([date, totals]) => ({
    source: 'meta_ads',
    date,
    totals: {
      ...totals,
      spendUsd: Number(totals.spendUsd.toFixed(2)),
    },
  }));
}

async function insertDailySnapshots(client, scanId, latestData) {
  const snapshots = [
    ...buildRevenueSnapshots(latestData),
    ...buildCogsSnapshots(latestData),
    ...buildMetaSnapshots(latestData),
  ];

  for (const snapshot of snapshots) {
    await client.query(
      `insert into daily_source_snapshots (source, date, scan_id, totals)
      values ($1, $2, $3, $4::jsonb)
      on conflict (source, date, scan_id) do update set
        totals = excluded.totals`,
      [snapshot.source, snapshot.date, String(scanId), json(snapshot.totals)]
    );
  }

  return snapshots.length;
}

async function persistScanLedger({ scanResult, latestData }) {
  if (!postgres.isConfigured()) {
    return { skipped: true, reason: 'database-url-missing' };
  }
  if (!scanResult?.scanId) {
    return { skipped: true, reason: 'scan-id-missing' };
  }

  return postgres.withClient(async client => {
    await client.query('begin');
    try {
      await upsertScanRun(client, scanResult, latestData || {});
      const imwebOrders = await upsertImwebOrders(client, scanResult.scanId, latestData?.orders);
      const dailySnapshots = await insertDailySnapshots(client, scanResult.scanId, latestData || {});
      await client.query('commit');
      return { ok: true, imwebOrders, dailySnapshots };
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
}

async function recordTelegramReportDelivery({
  reportDate,
  status,
  payload = null,
  sentAt = null,
  error = null,
  metadata = {},
}) {
  if (!postgres.isConfigured()) {
    return { skipped: true, reason: 'database-url-missing' };
  }
  if (!reportDate) {
    return { skipped: true, reason: 'report-date-missing' };
  }

  return postgres.query(
    `insert into telegram_report_deliveries (
      report_date,
      status,
      payload,
      sent_at,
      error,
      metadata,
      updated_at
    ) values ($1, $2, $3, $4, $5, $6::jsonb, now())
    on conflict (report_date) do update set
      status = excluded.status,
      payload = excluded.payload,
      sent_at = excluded.sent_at,
      error = excluded.error,
      metadata = excluded.metadata,
      updated_at = now()`,
    [
      reportDate,
      status,
      payload,
      sentAt,
      error,
      json(metadata),
    ]
  );
}

function normalizeAuditLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 500;
  return Math.min(Math.floor(limit), 2000);
}

function normalizeAuditLookbackHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return 48;
  return Math.min(Math.floor(hours), 24 * 30);
}

async function listRecentImwebOrdersForNotificationAudit(options = {}) {
  if (!postgres.isConfigured()) {
    return { skipped: true, reason: 'database-url-missing' };
  }

  const params = [];
  const where = [
    'ordered_at is not null',
    '(approved_amount > 0 or refunded_amount > 0)',
  ];

  if (options.sinceTime) {
    const since = parseDate(options.sinceTime);
    if (!since) {
      return { skipped: true, reason: 'invalid-since-time' };
    }
    params.push(since.toISOString());
    where.push(`ordered_at >= $${params.length}`);
  } else {
    params.push(normalizeAuditLookbackHours(options.lookbackHours));
    where.push(`ordered_at >= now() - ($${params.length}::int * interval '1 hour')`);
  }

  params.push(normalizeAuditLimit(options.limit));
  const limitRef = `$${params.length}`;

  const result = await postgres.query(
    `select
      order_no,
      ordered_at,
      order_date,
      approved_amount,
      refunded_amount,
      raw,
      last_seen_scan_id,
      last_seen_at
    from imweb_orders
    where ${where.join(' and ')}
    order by ordered_at desc
    limit ${limitRef}`,
    params
  );

  return {
    ok: true,
    orders: result.rows,
  };
}

module.exports = {
  buildCogsSnapshots,
  buildMetaSnapshots,
  buildRevenueSnapshots,
  listRecentImwebOrdersForNotificationAudit,
  persistScanLedger,
  recordTelegramReportDelivery,
};
