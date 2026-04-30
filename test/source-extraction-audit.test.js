const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSourceExtractionAudit,
  buildProjectionReconciliation,
} = require('../server/services/sourceExtractionAuditService');

function createLatestData(overrides = {}) {
  const latestData = {
    orders: [
      {
        orderNo: 'order-1',
        wtime: '2026-04-30T01:00:00.000Z',
        totalPaymentPrice: 90000,
        totalRefundedPrice: 10000,
      },
      {
        orderNo: 'order-2',
        wtime: '2026-04-30T02:00:00.000Z',
        totalPaymentPrice: 50000,
        totalRefundedPrice: 0,
      },
    ],
    revenueData: {
      totalRevenue: 150000,
      totalRefunded: 10000,
      netRevenue: 140000,
      totalOrders: 2,
      dailyRevenue: {
        '2026-04-30': {
          revenue: 150000,
          refunded: 10000,
          orders: 2,
        },
      },
    },
    campaignInsights: [
      {
        campaign_id: 'campaign-1',
        date_start: '2026-04-30',
        spend: '10.25',
        clicks: '20',
        impressions: '1000',
        actions: [{ action_type: 'purchase', value: '2' }],
      },
    ],
    adInsights: [
      {
        ad_id: 'ad-1',
        date_start: '2026-04-30',
        spend: '10.25',
        clicks: '20',
        impressions: '1000',
        actions: [{ action_type: 'purchase', value: '2' }],
      },
    ],
    cogsData: {
      totalCOGS: 30000,
      totalShipping: 5000,
      totalCOGSWithShipping: 35000,
      itemCount: 2,
      orderCount: 2,
      purchaseCount: 2,
      refundCount: 0,
      incompletePurchaseCount: 0,
      missingCostItemCount: 0,
      pendingRecoveryItemCount: 0,
      orders: [{ orderNo: 'order-1' }, { orderNo: 'order-2' }],
      dailyCOGS: {
        '2026-04-30': {
          cost: 30000,
          shipping: 5000,
          purchases: 2,
          costCoverageRatio: 1,
        },
      },
    },
    fx: {
      base: 'USD',
      quote: 'KRW',
      source: 'test-rate',
      usdToKrwRate: 1500,
      rateDate: '2026-04-30',
      fetchedAt: '2026-04-30T00:00:00.000Z',
      stale: false,
    },
    sources: {
      imweb: { status: 'connected', stale: false },
      metaInsights: { status: 'connected', stale: false },
      cogs: { status: 'connected', stale: false },
    },
  };

  return {
    ...latestData,
    ...overrides,
  };
}

function createSourceResults(overrides = {}) {
  const results = {
    imweb: {
      ok: true,
      validation: { valid: true, warnings: [], errors: [] },
      received: {
        rowCount: 2,
        recognizedOrders: 2,
        grossRevenue: 150000,
        refundedAmount: 10000,
        netRevenue: 140000,
      },
      acceptedRows: 2,
    },
    metaInsights: {
      ok: true,
      adSince: '2026-04-30',
      validation: { valid: true, warnings: [], errors: [] },
      received: {
        campaignRows: 1,
        adRows: 1,
        spendUsd: 10.25,
      },
      acceptedRows: 1,
    },
    cogs: {
      ok: true,
      validation: { valid: true, warnings: [], errors: [] },
      received: {
        rowCount: 2,
        itemCount: 2,
        totalCOGS: 30000,
        totalShipping: 5000,
      },
      acceptedRows: 2,
    },
  };

  return {
    ...results,
    ...overrides,
  };
}

test('source extraction audit reconciles canonical sources to the financial projection', () => {
  const latestData = createLatestData();
  const audit = buildSourceExtractionAudit({
    scanId: 'scan-1',
    since: '2026-04-30',
    until: '2026-04-30',
    sourceResults: createSourceResults(),
    latestData,
  });

  assert.equal(audit.status, 'reconciled');
  assert.equal(audit.reconciliation.status, 'reconciled');
  assert.deepEqual(audit.summary.failedChecks, []);
  assert.deepEqual(audit.summary.failedFetches, []);
  assert.equal(audit.reconciliation.sourceTotals.imweb.grossRevenue, 150000);
  assert.equal(audit.reconciliation.sourceTotals.meta.spendUsd, 10.25);
  assert.equal(audit.reconciliation.sourceTotals.meta.attributedPurchases, 2);
  assert.equal(audit.reconciliation.sourceTotals.cogs.purchaseCount, 2);
  assert.equal(audit.reconciliation.sourceTotals.cogs.refundCount, 0);
  assert.equal(audit.reconciliation.projectionTotals.adSpendKRW, 15375);
  assert.equal(audit.reconciliation.projectionTotals.trueNetProfit, 81225);
});

test('source extraction audit reports distinct source dates instead of source row counts', () => {
  const latestData = createLatestData({
    orders: [
      { orderNo: 'order-1', wtime: '2026-04-30T01:00:00.000Z', totalPaymentPrice: 90000, totalRefundedPrice: 10000 },
      { orderNo: 'order-2', wtime: '2026-04-30T02:00:00.000Z', totalPaymentPrice: 50000, totalRefundedPrice: 0 },
    ],
    revenueData: {
      totalRevenue: 150000,
      totalRefunded: 10000,
      netRevenue: 140000,
      totalOrders: 2,
      dailyRevenue: {
        '2026-04-30': { revenue: 150000, refunded: 10000, orders: 2 },
      },
    },
    campaignInsights: [
      { campaign_id: 'campaign-1', date_start: '2026-04-30', spend: '10.25', actions: [] },
      { campaign_id: 'campaign-2', date_start: '2026-04-30', spend: '5.00', actions: [] },
      { campaign_id: 'campaign-1', date_start: '2026-05-01', spend: '1.00', actions: [] },
    ],
  });

  const reconciliation = buildProjectionReconciliation(latestData);

  assert.equal(reconciliation.sourceTotals.imweb.rowCount, 2);
  assert.equal(reconciliation.sourceTotals.imweb.dayCount, 1);
  assert.equal(reconciliation.sourceTotals.meta.campaignRows, 3);
  assert.equal(reconciliation.sourceTotals.meta.dayCount, 2);
});

test('source extraction audit reconciles Meta spend using daily KRW rounding', () => {
  const latestData = createLatestData({
    orders: [],
    revenueData: {
      totalRevenue: 0,
      totalRefunded: 0,
      netRevenue: 0,
      totalOrders: 0,
      dailyRevenue: {},
    },
    campaignInsights: [
      { campaign_id: 'campaign-1', date_start: '2026-04-29', spend: '0.01', actions: [] },
      { campaign_id: 'campaign-1', date_start: '2026-04-30', spend: '0.01', actions: [] },
    ],
    adInsights: [],
    cogsData: {
      totalCOGS: 0,
      totalShipping: 0,
      totalCOGSWithShipping: 0,
      itemCount: 0,
      orderCount: 0,
      incompletePurchaseCount: 0,
      missingCostItemCount: 0,
      pendingRecoveryItemCount: 0,
      orders: [],
      dailyCOGS: {},
    },
    fx: {
      base: 'USD',
      quote: 'KRW',
      source: 'test-rate',
      usdToKrwRate: 1450,
      rateDate: '2026-04-30',
      fetchedAt: '2026-04-30T00:00:00.000Z',
      stale: false,
    },
  });

  const reconciliation = buildProjectionReconciliation(latestData);

  assert.equal(reconciliation.status, 'reconciled');
  assert.equal(reconciliation.projectionTotals.adSpendKRW, 30);
  assert.ok(!reconciliation.failedChecks.includes('meta_spend_krw_to_waterfall'));
});

test('source extraction audit fails loud when Imweb cash totals drift from revenue input', () => {
  const latestData = createLatestData({
    revenueData: {
      totalRevenue: 149000,
      totalRefunded: 10000,
      netRevenue: 139000,
      totalOrders: 2,
      dailyRevenue: {
        '2026-04-30': {
          revenue: 149000,
          refunded: 10000,
          orders: 2,
        },
      },
    },
  });

  const reconciliation = buildProjectionReconciliation(latestData);

  assert.equal(reconciliation.status, 'mismatch');
  assert.ok(reconciliation.failedChecks.includes('imweb_orders_to_revenue_gross'));
  assert.ok(reconciliation.failedChecks.includes('imweb_orders_to_revenue_net'));
});

test('source extraction audit fails loud when recognized order counts drift from projection rows', () => {
  const latestData = createLatestData({
    revenueData: {
      totalRevenue: 150000,
      totalRefunded: 10000,
      netRevenue: 140000,
      totalOrders: 1,
      dailyRevenue: {
        '2026-04-30': {
          revenue: 150000,
          refunded: 10000,
          orders: 2,
        },
      },
    },
  });

  const reconciliation = buildProjectionReconciliation(latestData);

  assert.equal(reconciliation.status, 'mismatch');
  assert.ok(reconciliation.failedChecks.includes('imweb_orders_to_revenue_orders'));
  assert.ok(reconciliation.failedChecks.includes('revenue_to_projection_orders'));
});

test('source extraction audit fails loud when revenue date range does not cover COGS', () => {
  const latestData = createLatestData({
    orders: [
      {
        orderNo: 'order-1',
        wtime: '2026-04-29T01:00:00.000Z',
        totalPaymentPrice: 150000,
        totalRefundedPrice: 0,
      },
    ],
    revenueData: {
      totalRevenue: 150000,
      totalRefunded: 0,
      netRevenue: 150000,
      totalOrders: 1,
      dailyRevenue: {
        '2026-04-29': {
          revenue: 150000,
          refunded: 0,
          orders: 1,
        },
      },
    },
    cogsData: {
      totalCOGS: 30000,
      totalShipping: 5000,
      totalCOGSWithShipping: 35000,
      itemCount: 1,
      orderCount: 1,
      purchaseCount: 1,
      refundCount: 0,
      incompletePurchaseCount: 0,
      missingCostItemCount: 0,
      pendingRecoveryItemCount: 0,
      orders: [{ orderNo: 'order-2' }],
      dailyCOGS: {
        '2026-04-30': {
          cost: 30000,
          shipping: 5000,
          purchases: 1,
          costCoverageRatio: 1,
        },
      },
    },
  });

  const reconciliation = buildProjectionReconciliation(latestData);

  assert.equal(reconciliation.status, 'mismatch');
  assert.ok(reconciliation.failedChecks.includes('revenue_date_range_covers_cogs'));
});

test('source extraction audit preserves last-known-good projection but marks failed fetches', () => {
  const latestData = createLatestData({
    sources: {
      imweb: { status: 'connected', stale: true, lastError: 'timeout' },
      metaInsights: { status: 'connected', stale: false },
      cogs: { status: 'connected', stale: false },
    },
  });
  const audit = buildSourceExtractionAudit({
    scanId: 'scan-2',
    since: '2026-04-30',
    until: '2026-04-30',
    sourceResults: createSourceResults({
      imweb: { ok: false, error: 'timeout' },
    }),
    latestData,
  });

  assert.equal(audit.status, 'reconciled_with_stale_sources');
  assert.equal(audit.reconciliation.status, 'reconciled');
  assert.deepEqual(audit.summary.failedFetches, ['imweb']);
  assert.deepEqual(audit.summary.staleSources, ['imweb']);
  assert.equal(audit.sources.imweb.accepted.rowCount, 0);
  assert.equal(audit.sources.imweb.accepted.latestRowCount, 2);
});
