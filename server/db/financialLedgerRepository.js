const { createHash } = require('node:crypto');
const postgres = require('./postgres');
const { getOrderCashTotals } = require('../domain/imwebPayments');
const { formatDateInTimeZone } = require('../domain/time');

// Rebuilt by a full reconciliation on process startup; never advance before commit.
let committedOrderFingerprints = new Map();

function asArray(value) {
  return Array.isArray(value) ? value : [];
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
  const unchangedOrderNos = [];
  const nextFingerprints = new Map();

  for (const order of asArray(orders)) {
    const orderNo = getOrderNo(order);
    if (!orderNo) continue;

    const raw = json(order);
    const fingerprint = createHash('sha256').update(raw).digest('hex');
    const previousFingerprint = nextFingerprints.has(orderNo)
      ? nextFingerprints.get(orderNo) : committedOrderFingerprints.get(orderNo);
    nextFingerprints.set(orderNo, fingerprint);
    if (previousFingerprint === fingerprint) {
      unchangedOrderNos.push(orderNo);
      continue;
    }

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
        raw,
        String(scanId),
      ]
    );
    persisted += 1;
  }

  // Keep scan freshness without sending unchanged financial payloads over the network.
  if (unchangedOrderNos.length) {
    await client.query(
      `update imweb_orders set last_seen_scan_id = $2, last_seen_at = now()
       where order_no = any($1::text[])`,
      [unchangedOrderNos, String(scanId)]
    );
  }

  return { persisted, unchanged: unchangedOrderNos.length, nextFingerprints };
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
      const orders = await upsertImwebOrders(client, scanResult.scanId, latestData?.orders);
      await client.query('commit');
      committedOrderFingerprints = orders.nextFingerprints;
      return { ok: true, imwebOrders: orders.persisted, unchangedOrders: orders.unchanged };
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

function normalizeTelegramReportLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 30;
  return Math.min(Math.floor(limit), 120);
}

function normalizeTelegramReportRow(row = {}) {
  return {
    reportDate: row.report_date || row.reportDate || null,
    status: row.status || null,
    payload: row.payload || null,
    sentAt: row.sent_at || row.sentAt || null,
    error: row.error || null,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    updatedAt: row.updated_at || row.updatedAt || null,
  };
}

async function listPendingCogsDailyReportDeliveries(options = {}) {
  if (!postgres.isConfigured()) {
    return { skipped: true, reason: 'database-url-missing' };
  }

  const result = await postgres.query(
    `select
      report_date::text as report_date,
      status,
      payload,
      sent_at,
      error,
      metadata,
      updated_at
    from telegram_report_deliveries
    where status in ('sent', 'corrected')
      and (
        payload like '%N/A (COGS pending)%'
        or metadata->>'profitIsEstimated' = 'true'
        or metadata->>'chartPending' = 'true'
      )
    order by report_date asc
    limit $1`,
    [normalizeTelegramReportLimit(options.limit)]
  );

  return {
    ok: true,
    reports: result.rows.map(normalizeTelegramReportRow),
  };
}

async function listRecentDailyReportDeliveries(options = {}) {
  if (!postgres.isConfigured()) return { skipped: true, reason: 'database-url-missing' };
  const result = await postgres.query(
    `select report_date::text as report_date, status, payload, sent_at, error, metadata, updated_at
    from telegram_report_deliveries
    where status in ('sent', 'corrected') and report_date >= $1::date
    order by report_date desc
    limit $2`,
    [options.sinceDate, normalizeTelegramReportLimit(options.limit || 21)]
  );
  return { ok: true, reports: result.rows.map(normalizeTelegramReportRow) };
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
  listRecentDailyReportDeliveries,
  listPendingCogsDailyReportDeliveries,
  listRecentImwebOrdersForNotificationAudit,
  persistScanLedger,
  recordTelegramReportDelivery,
};
