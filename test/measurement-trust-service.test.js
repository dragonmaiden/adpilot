const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMeasurementTrust } = require('../server/services/measurementTrustService');

test('buildMeasurementTrust freezes budget changes when fresh revenue and COGS are unavailable', () => {
  const trust = buildMeasurementTrust({
    sourceHealth: {
      metaInsights: { status: 'connected', stale: false, hasData: true },
      imweb: { status: 'error', stale: true, hasData: false },
      cogs: { status: 'error', stale: false, hasData: false },
    },
    revenueSource: { status: 'disconnected', stale: true },
    campaignEconomicsSummary: { coverageRatio: 0.2, confidence: 'low', hasReliableCoverage: false },
    profitContext: { coverageRatio: 0.2, hasReliableCoverage: false },
  });

  assert.equal(trust.level, 'low');
  assert.equal(trust.shouldFreezeBudgetChanges, true);
  assert.equal(trust.canScale, false);
  assert.match(trust.reason, /Fresh revenue data is unavailable|COGS source health is degraded/);
});

test('buildMeasurementTrust stays decision-grade when source freshness and coverage are healthy', () => {
  const trust = buildMeasurementTrust({
    sourceHealth: {
      metaInsights: { status: 'connected', stale: false, hasData: true },
      imweb: { status: 'connected', stale: false, hasData: true },
      cogs: { status: 'connected', stale: false, hasData: true },
    },
    revenueSource: { status: 'connected', stale: false },
    campaignEconomicsSummary: { coverageRatio: 0.92, confidence: 'high', hasReliableCoverage: true },
    profitContext: { coverageRatio: 0.91, hasReliableCoverage: true },
  });

  assert.equal(trust.level, 'high');
  assert.equal(trust.shouldFreezeBudgetChanges, false);
  assert.equal(trust.canScale, true);
  assert.equal(trust.reason, 'Measurement inputs are healthy enough for budget decisions');
});
