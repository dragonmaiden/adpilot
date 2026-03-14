const test = require('node:test');
const assert = require('node:assert/strict');

const { getTodayInTimeZone, getHourInTimeZone } = require('../server/domain/time');

async function withMockedLivePerformanceService(overrides, run) {
  const servicePath = require.resolve('../server/services/livePerformanceService');
  const schedulerPath = require.resolve('../server/modules/scheduler');
  const originalScheduler = require.cache[schedulerPath] || null;
  const originalService = require.cache[servicePath] || null;

  require.cache[schedulerPath] = {
    id: schedulerPath,
    filename: schedulerPath,
    loaded: true,
    exports: overrides.scheduler,
  };
  delete require.cache[servicePath];

  try {
    const service = require(servicePath);
    return await run(service);
  } finally {
    delete require.cache[servicePath];
    if (originalService) {
      require.cache[servicePath] = originalService;
    }

    if (originalScheduler) {
      require.cache[schedulerPath] = originalScheduler;
    } else {
      delete require.cache[schedulerPath];
    }
  }
}

function kstIso(dateKey, hour, minute = 0) {
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return new Date(`${dateKey}T${hh}:${mm}:00+09:00`).toISOString();
}

test('buildLivePerformanceResponse returns intraday chart, spend snapshots, and confidence-aware summary', async () => {
  const dateKey = getTodayInTimeZone();
  const currentHour = getHourInTimeZone(new Date());
  const firstHour = Math.max(0, currentHour - 1);
  const secondHour = currentHour;

  const latestData = {
    timestamp: kstIso(dateKey, secondHour, 20),
    campaigns: [{ id: 'c1', name: 'Main', status: 'ACTIVE', dailyBudget: 10000 }],
    campaignInsights: [
      { campaign_id: 'c1', date_start: dateKey, spend: 20 },
    ],
    revenueData: {
      totalRevenue: 150000,
    },
    cogsData: {
      totalCOGSWithShipping: 52500,
    },
    economicsLedger: {
      orderSnapshots: [
        {
          date: dateKey,
          orderedAt: kstIso(dateKey, firstHour, 10),
          recognizedCash: true,
          netPaidAmount: 100000,
          approvedAmount: 100000,
          cogsMatched: true,
          cogsCost: 30000,
          cogsShipping: 5000,
        },
        {
          date: dateKey,
          orderedAt: kstIso(dateKey, secondHour, 5),
          recognizedCash: true,
          netPaidAmount: 50000,
          approvedAmount: 50000,
          cogsMatched: false,
          cogsCost: 0,
          cogsShipping: 0,
        },
      ],
    },
  };

  const snapshots = [
    {
      scanId: '1',
      timestamp: kstIso(dateKey, firstHour, 15),
    },
    {
      scanId: '2',
      timestamp: kstIso(dateKey, secondHour, 15),
    },
  ];

  const snapshotData = {
    '1': {
      data: {
        meta_insights: {
          campaignInsights: [{ campaign_id: 'c1', date_start: dateKey, spend: 5 }],
        },
      },
    },
    '2': {
      data: {
        meta_insights: {
          campaignInsights: [{ campaign_id: 'c1', date_start: dateKey, spend: 20 }],
        },
      },
    },
  };

  await withMockedLivePerformanceService({
    scheduler: {
      getLatestData: () => latestData,
      getSnapshotsList: () => snapshots,
      getSnapshot: scanId => snapshotData[String(scanId)] || null,
    },
  }, async service => {
    const response = service.buildLivePerformanceResponse();

    assert.equal(response.intraday.date, dateKey);
    assert.equal(response.intraday.chart.snapshotCount, 2);
    assert.equal(response.intraday.chart.usingSnapshotSpend, true);
    assert.equal(response.intraday.summary.ordersSoFar, 2);
    assert.equal(response.intraday.confidence.level, 'medium');
    assert.ok(response.intraday.summary.spendSoFarKrw > 0);
    assert.ok(response.intraday.summary.revenueSoFarKrw >= 150000);
    assert.ok(Array.isArray(response.intraday.chart.points));
    assert.equal(response.intraday.chart.points.length, 24);
    assert.ok(response.intraday.chart.points[secondHour].cumulativeSpendKrw >= response.intraday.chart.points[firstHour].cumulativeSpendKrw);
    assert.ok(response.intraday.highlights.length >= 3);
  });
});

test('buildLivePerformanceResponse falls back to current spend when no intraday snapshots exist', async () => {
  const dateKey = getTodayInTimeZone();
  const currentHour = getHourInTimeZone(new Date());

  const latestData = {
    timestamp: kstIso(dateKey, currentHour, 30),
    campaigns: [{ id: 'c1', name: 'Main', status: 'ACTIVE', dailyBudget: 10000 }],
    campaignInsights: [
      { campaign_id: 'c1', date_start: dateKey, spend: 12 },
    ],
    revenueData: {},
    cogsData: {},
    economicsLedger: {
      orderSnapshots: [],
    },
  };

  await withMockedLivePerformanceService({
    scheduler: {
      getLatestData: () => latestData,
      getSnapshotsList: () => [],
      getSnapshot: () => null,
    },
  }, async service => {
    const response = service.buildLivePerformanceResponse();

    assert.equal(response.intraday.chart.snapshotCount, 0);
    assert.equal(response.intraday.chart.usingSnapshotSpend, false);
    assert.ok(response.intraday.summary.spendSoFarKrw > 0);
    assert.equal(response.intraday.summary.ordersSoFar, 0);
    assert.equal(response.intraday.confidence.level, 'neutral');
  });
});

test('buildLivePerformanceResponse keeps intraday output focused on today even when a window is selected', async () => {
  const dateKey = getTodayInTimeZone();
  const currentHour = getHourInTimeZone(new Date());

  const latestData = {
    timestamp: kstIso(dateKey, currentHour, 30),
    campaigns: [{ id: 'c1', name: 'Main', status: 'ACTIVE', dailyBudget: 10000 }],
    campaignInsights: [
      { campaign_id: 'c1', date_start: dateKey, spend: 12 },
    ],
    revenueData: {
      totalRevenue: 240000,
    },
    cogsData: {
      totalCOGSWithShipping: 84000,
    },
    economicsLedger: {
      orderSnapshots: [],
    },
  };

  await withMockedLivePerformanceService({
    scheduler: {
      getLatestData: () => latestData,
      getSnapshotsList: () => [],
      getSnapshot: () => null,
    },
  }, async service => {
    const response = service.buildLivePerformanceResponse({ days: '7d' });

    assert.ok(Array.isArray(response.intraday.chart.points));
    assert.equal(response.intraday.chart.points.length, 24);
    assert.equal('benchmark' in response.intraday.chart, false);
    assert.equal(response.intraday.chart.usingSnapshotSpend, false);
  });
});
