const config = require('../config');
const contracts = require('../contracts/v1');
const scheduler = require('../modules/scheduler');
const { convertUsdToKrw } = require('../domain/metrics');
const { getTodayInTimeZone, getHourInTimeZone, formatDateInTimeZone, KST_TIME_ZONE } = require('../domain/time');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value) {
  return Math.round(asNumber(value));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sumTodaySpendKrw(campaignInsights, dateKey) {
  const spendUsd = asArray(campaignInsights)
    .filter(row => String(row?.date_start || '') === dateKey)
    .reduce((sum, row) => sum + asNumber(row?.spend), 0);
  return roundMoney(convertUsdToKrw(spendUsd));
}

function getSnapshotSpendSamples(dateKey) {
  const metas = asArray(scheduler.getSnapshotsList()).slice().reverse();
  const samples = [];

  for (const meta of metas) {
    if (!meta?.scanId || !meta?.timestamp) continue;
    if (formatDateInTimeZone(meta.timestamp, KST_TIME_ZONE) !== dateKey) continue;

    const snapshot = scheduler.getSnapshot(meta.scanId);
    const campaignInsights = snapshot?.data?.meta_insights?.campaignInsights;
    if (!Array.isArray(campaignInsights) || campaignInsights.length === 0) continue;

    const spendKrw = sumTodaySpendKrw(campaignInsights, dateKey);
    samples.push({
      scanId: String(meta.scanId),
      timestamp: meta.timestamp,
      hour: getHourInTimeZone(meta.timestamp, KST_TIME_ZONE),
      spendKrw,
    });
  }

  return samples.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
}

function getLiveSpendFallback(latestData, dateKey) {
  const spendKrw = sumTodaySpendKrw(latestData?.campaignInsights, dateKey);
  if (spendKrw <= 0) return null;

  return {
    scanId: 'latest',
    timestamp: latestData?.timestamp || new Date().toISOString(),
    hour: getHourInTimeZone(latestData?.timestamp || new Date(), KST_TIME_ZONE),
    spendKrw,
  };
}

function getFallbackCogsRate(orderSnapshots, latestData) {
  const matchedSnapshots = asArray(orderSnapshots).filter(row => row?.recognizedCash && asNumber(row?.netPaidAmount) > 0 && row?.cogsMatched);
  const matchedRevenue = matchedSnapshots.reduce((sum, row) => sum + asNumber(row?.netPaidAmount), 0);
  const matchedCosts = matchedSnapshots.reduce((sum, row) => sum + asNumber(row?.cogsCost) + asNumber(row?.cogsShipping), 0);

  if (matchedRevenue > 0 && matchedCosts > 0) {
    return clamp(matchedCosts / matchedRevenue, 0, 0.9);
  }

  const totalRevenue = asNumber(latestData?.revenueData?.totalRevenue);
  const totalCogs = asNumber(latestData?.cogsData?.totalCOGSWithShipping);
  if (totalRevenue > 0 && totalCogs > 0) {
    return clamp(totalCogs / totalRevenue, 0, 0.9);
  }

  return 0;
}

function buildHourlyEconomics(orderSnapshots, latestData, dateKey) {
  const hourlyRevenue = new Array(24).fill(0);
  const hourlyContributionBeforeAds = new Array(24).fill(0);
  const hourlyOrders = new Array(24).fill(0);
  const fallbackCogsRate = getFallbackCogsRate(orderSnapshots, latestData);

  let coveredRevenue = 0;
  let recognizedRevenue = 0;

  for (const row of asArray(orderSnapshots)) {
    if (!row?.recognizedCash || String(row?.date || '') !== dateKey || !row?.orderedAt) continue;

    const revenue = asNumber(row?.netPaidAmount || row?.approvedAmount);
    if (revenue <= 0) continue;

    const hour = clamp(getHourInTimeZone(row.orderedAt, KST_TIME_ZONE), 0, 23);
    const cogsCost = row?.cogsMatched
      ? asNumber(row?.cogsCost) + asNumber(row?.cogsShipping)
      : revenue * fallbackCogsRate;
    const paymentFees = revenue * asNumber(config.fees.paymentFeeRate);
    const contributionBeforeAds = revenue - cogsCost - paymentFees;

    recognizedRevenue += revenue;
    if (row?.cogsMatched) {
      coveredRevenue += revenue;
    }

    hourlyRevenue[hour] += revenue;
    hourlyContributionBeforeAds[hour] += contributionBeforeAds;
    hourlyOrders[hour] += 1;
  }

  return {
    hourlyRevenue,
    hourlyContributionBeforeAds,
    hourlyOrders,
    recognizedRevenue,
    coveredRevenue,
    exactCoverageRatio: recognizedRevenue > 0 ? coveredRevenue / recognizedRevenue : 0,
    fallbackCogsRate,
  };
}

function buildHourlySpendSeries(spendSamples, fallbackSample, currentHour) {
  const samples = Array.isArray(spendSamples) && spendSamples.length > 0
    ? spendSamples
    : (fallbackSample ? [fallbackSample] : []);
  const sorted = samples.slice().sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));

  const hourlySpend = [];
  let sampleIndex = 0;
  let lastSpend = 0;

  for (let hour = 0; hour < 24; hour += 1) {
    while (sampleIndex < sorted.length && asNumber(sorted[sampleIndex]?.hour) <= hour) {
      lastSpend = Math.max(lastSpend, asNumber(sorted[sampleIndex]?.spendKrw));
      sampleIndex += 1;
    }
    hourlySpend.push(hour <= currentHour ? lastSpend : null);
  }

  return {
    hourlySpend,
    sampleCount: sorted.length,
    samples: sorted,
  };
}

function buildConfidenceMeta(exactCoverageRatio, orderCount) {
  if (orderCount === 0) {
    return {
      level: 'neutral',
      label: 'No orders yet',
      detail: 'Profit will become meaningful once today starts converting.',
    };
  }

  if (exactCoverageRatio >= 0.85) {
    return {
      level: 'high',
      label: 'High confidence',
      detail: 'Most of today’s revenue already has matched cost data behind it.',
    };
  }

  if (exactCoverageRatio >= 0.55) {
    return {
      level: 'medium',
      label: 'Partial confidence',
      detail: 'Today’s profit line is usable, but some orders still need cost completion.',
    };
  }

  return {
    level: 'low',
    label: 'Low confidence',
    detail: 'Today’s profit line is still estimated because cost coverage is thin.',
  };
}

function buildTakeaway({ spendSoFarKrw, revenueSoFarKrw, contributionAfterAdsKrw, paceDeltaPct, confidence }) {
  if (spendSoFarKrw <= 0 && revenueSoFarKrw <= 0) {
    return {
      tone: 'neutral',
      headline: 'Quiet start so far',
      detail: 'There is not enough live spend or order volume yet to form a pacing judgment.',
    };
  }

  if (paceDeltaPct >= 12 && contributionAfterAdsKrw < 0) {
    return {
      tone: 'warning',
      headline: 'Spending early, payoff still lagging',
      detail: 'Today is ahead of even spend pace, but contribution after ad spend has not caught up yet.',
    };
  }

  if (paceDeltaPct <= -12 && contributionAfterAdsKrw > 0) {
    return {
      tone: 'positive',
      headline: 'Efficient start with room to spend',
      detail: 'Revenue is keeping up while spend is still behind even pace, so the day is paying back cleanly so far.',
    };
  }

  if (contributionAfterAdsKrw > 0) {
    return {
      tone: confidence.level === 'low' ? 'neutral' : 'positive',
      headline: 'Spend is converting into profit so far',
      detail: confidence.level === 'low'
        ? 'The shape looks healthy, but treat the profit line as directional until more COGS rows close.'
        : 'Revenue and contribution are keeping up with spend through the day.',
    };
  }

  return {
    tone: confidence.level === 'low' ? 'neutral' : 'warning',
    headline: 'Today is live, but not yet paying back cleanly',
    detail: confidence.level === 'low'
      ? 'Profit confidence is still partial, so focus on pace and revenue first.'
      : 'Spend is active, but contribution after ad spend is still below zero right now.',
  };
}

function buildHighlights({ paceDeltaPct, spendSoFarKrw, revenueSoFarKrw, contributionAfterAdsKrw, orderCount, confidence, totalDailyBudgetKrw, expectedSpendKrw }) {
  const highlights = [];

  if (totalDailyBudgetKrw > 0) {
    const direction = paceDeltaPct >= 0 ? 'ahead of' : 'behind';
    highlights.push(`Spend is ${Math.abs(paceDeltaPct).toFixed(0)}% ${direction} even pace (${formatCompactKrw(spendSoFarKrw)} vs ${formatCompactKrw(expectedSpendKrw)} expected).`);
  } else {
    highlights.push(`Spend so far is ${formatCompactKrw(spendSoFarKrw)} and there is no active budget pool configured for pace comparisons.`);
  }

  if (orderCount > 0) {
    highlights.push(`Revenue is ${formatCompactKrw(revenueSoFarKrw)} from ${orderCount.toLocaleString()} orders, with contribution after ad spend at ${formatSignedCompactKrw(contributionAfterAdsKrw)}.`);
  } else {
    highlights.push('There are no recognized orders yet today, so this is still a pacing read more than a profitability read.');
  }

  highlights.push(confidence.detail);
  return highlights;
}

function formatCompactKrw(value) {
  const amount = Math.abs(roundMoney(value));
  if (amount >= 1000000) return `₩${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `₩${Math.round(amount / 1000)}K`;
  return `₩${amount.toLocaleString('en-US')}`;
}

function formatSignedCompactKrw(value) {
  const rounded = roundMoney(value);
  return rounded >= 0 ? formatCompactKrw(rounded) : `-${formatCompactKrw(Math.abs(rounded))}`;
}

function buildLivePerformanceResponse() {
  const latestData = scheduler.getLatestData();
  const campaigns = asArray(latestData?.campaigns);
  const activeCampaigns = campaigns.filter(campaign => String(campaign?.status) === 'ACTIVE');
  const dateKey = getTodayInTimeZone(KST_TIME_ZONE);
  const now = new Date();
  const currentHour = getHourInTimeZone(now, KST_TIME_ZONE);

  const spendSamples = getSnapshotSpendSamples(dateKey);
  const fallbackSample = getLiveSpendFallback(latestData, dateKey);
  const spendSeries = buildHourlySpendSeries(spendSamples, fallbackSample, currentHour);

  const economics = buildHourlyEconomics(latestData?.economicsLedger?.orderSnapshots, latestData, dateKey);

  const totalDailyBudgetUsd = activeCampaigns.reduce((sum, campaign) => {
    const dailyBudgetCents = asNumber(campaign?.dailyBudget ?? campaign?.daily_budget);
    return sum + (dailyBudgetCents > 0 ? dailyBudgetCents / 100 : 0);
  }, 0);
  const totalDailyBudgetKrw = roundMoney(convertUsdToKrw(totalDailyBudgetUsd));

  const minutesIntoDay = currentHour * 60 + now.getMinutes();
  const expectedSpendKrw = totalDailyBudgetKrw > 0
    ? roundMoney((totalDailyBudgetKrw * minutesIntoDay) / (24 * 60))
    : 0;

  const points = [];
  let cumulativeRevenue = 0;
  let cumulativeContributionBeforeAds = 0;
  let cumulativeOrders = 0;

  for (let hour = 0; hour < 24; hour += 1) {
    cumulativeRevenue += roundMoney(economics.hourlyRevenue[hour]);
    cumulativeContributionBeforeAds += roundMoney(economics.hourlyContributionBeforeAds[hour]);
    cumulativeOrders += asNumber(economics.hourlyOrders[hour]);
    const cumulativeSpend = spendSeries.hourlySpend[hour];
    const contributionAfterAds = Number.isFinite(cumulativeSpend)
      ? roundMoney(cumulativeContributionBeforeAds - cumulativeSpend)
      : null;

    points.push({
      hour,
      label: String(hour).padStart(2, '0'),
      cumulativeSpendKrw: cumulativeSpend,
      expectedSpendKrw: hour <= currentHour && totalDailyBudgetKrw > 0
        ? roundMoney((totalDailyBudgetKrw * ((hour + 1) * 60)) / (24 * 60))
        : null,
      cumulativeRevenueKrw: hour <= currentHour ? cumulativeRevenue : null,
      cumulativeContributionBeforeAdsKrw: hour <= currentHour ? roundMoney(cumulativeContributionBeforeAds) : null,
      cumulativeContributionAfterAdsKrw: hour <= currentHour ? contributionAfterAds : null,
      hourlyOrders: hour <= currentHour ? asNumber(economics.hourlyOrders[hour]) : null,
    });
  }

  const currentPoint = points[Math.min(currentHour, points.length - 1)] || null;
  const spendSoFarKrw = asNumber(currentPoint?.cumulativeSpendKrw);
  const revenueSoFarKrw = asNumber(currentPoint?.cumulativeRevenueKrw);
  const contributionBeforeAdsKrw = asNumber(currentPoint?.cumulativeContributionBeforeAdsKrw);
  const contributionAfterAdsKrw = asNumber(currentPoint?.cumulativeContributionAfterAdsKrw);
  const orderCount = cumulativeOrders;
  const aovKrw = orderCount > 0 ? roundMoney(revenueSoFarKrw / orderCount) : 0;
  const roas = spendSoFarKrw > 0 ? revenueSoFarKrw / spendSoFarKrw : 0;
  const poas = spendSoFarKrw > 0 ? contributionBeforeAdsKrw / spendSoFarKrw : 0;
  const paceDeltaPct = expectedSpendKrw > 0 ? ((spendSoFarKrw - expectedSpendKrw) / expectedSpendKrw) * 100 : 0;

  const confidence = buildConfidenceMeta(economics.exactCoverageRatio, orderCount);
  const takeaway = buildTakeaway({
    spendSoFarKrw,
    revenueSoFarKrw,
    contributionAfterAdsKrw,
    paceDeltaPct,
    confidence,
  });

  return contracts.livePerformance({
    generatedAt: new Date().toISOString(),
    intraday: {
      date: dateKey,
      timeZone: KST_TIME_ZONE,
      summary: {
        spendSoFarKrw,
        expectedSpendKrw,
        totalDailyBudgetKrw,
        revenueSoFarKrw,
        contributionBeforeAdsKrw,
        contributionAfterAdsKrw,
        ordersSoFar: orderCount,
        aovKrw,
        roas,
        poas,
        paceDeltaPct,
      },
      confidence,
      takeaway,
      highlights: buildHighlights({
        paceDeltaPct,
        spendSoFarKrw,
        revenueSoFarKrw,
        contributionAfterAdsKrw,
        orderCount,
        confidence,
        totalDailyBudgetKrw,
        expectedSpendKrw,
      }),
      chart: {
        points,
        snapshotCount: spendSamples.length,
        usingSnapshotSpend: spendSamples.length > 0,
      },
    },
  });
}

module.exports = {
  buildLivePerformanceResponse,
};
