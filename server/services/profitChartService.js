const crypto = require('crypto');
const { buildFinancialProjection } = require('./financialProjectionService');
const { shiftDate } = require('../domain/time');

function buildCumulativeProfitSeries(data, reportDate, financialDays) {
  const rows = financialDays
    .filter(row => row.date <= reportDate)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return [];
  const byDate = new Map(rows.map(row => [row.date, row]));
  const points = [];
  for (let date = rows[0].date; date <= reportDate; date = shiftDate(date, 1)) {
    const row = byDate.get(date);
    let dailyPending = false;
    let dailyEstimated = false;
    if (row) {
      const needsCosts = Number(row.orders) > 0 || row.revenue > 0;
      const missingRevenue = !Object.hasOwn(data.revenueData?.dailyRevenue || {}, date)
        && Number(data.cogsData?.dailyCOGS?.[date]?.purchases) > 0;
      if (missingRevenue || !Number.isFinite(row.trueNetProfit)
        || (needsCosts && !row.hasCOGS && !(row.cogsCoverageRatio > 0))) {
        dailyPending = true;
      }
      dailyEstimated = (needsCosts && !row.hasCOGS) || row.hasPendingRecovery === true;
    }
    points.push({ date,
      dailyValue: dailyPending ? null : (row?.trueNetProfit ?? 0), dailyEstimated });
  }
  // Start at the first usable monthly period, never at a few isolated days
  // before an incomplete month. Keep all daily values for the monthly bars.
  const firstUsableMonth = buildMonthlyProfitSeries(points, reportDate)
    .find(month => !month.pending)?.month;
  let total = 0;
  let estimated = false;
  let pending = false;
  return points.map(point => {
    if (!firstUsableMonth || point.date.slice(0, 7) < firstUsableMonth) {
      return { ...point, value: null, pending: true, estimated: false };
    }
    pending ||= point.dailyValue == null;
    estimated ||= point.dailyEstimated;
    if (point.dailyValue != null) total += point.dailyValue;
    return { ...point, value: pending ? null : total, pending, estimated };
  });
}

function buildMonthlyProfitSeries(points, reportDate) {
  const months = new Map();
  for (const point of points) {
    if (point.date > reportDate) continue;
    const month = point.date.slice(0, 7);
    const bucket = months.get(month) || { month, value: 0, pending: false, estimated: false,
      current: month === reportDate.slice(0, 7) };
    bucket.pending ||= point.dailyValue == null;
    bucket.estimated ||= point.dailyEstimated === true;
    bucket.value = bucket.pending ? null : bucket.value + point.dailyValue;
    months.set(month, bucket);
  }
  return [...months.values()];
}

function buildMonthlyProfitSvg(months) {
  const values = months.filter(month => month.value != null).map(month => month.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(max - min, 1);
  const y = value => 890 - (value - min) / span * 235;
  const slot = 900 / months.length;
  const width = Math.min(72, slot * 0.6);
  const compact = value => Math.abs(value) >= 1000000 ? `${(value / 1000000).toFixed(1)}m`
    : Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(0)}k` : String(Math.round(value));
  const elements = ['<text x="48" y="585" font-size="27" font-weight="bold" fill="#0f172a">Monthly net profit</text>',
    '<text x="48" y="617" font-size="18" fill="#64748b">Current month shown with a dotted outline · month to date</text>'];
  for (let i = 0; i <= 4; i += 1) {
    const value = min + span * i / 4;
    elements.push(`<line x1="125" x2="1025" y1="${y(value)}" y2="${y(value)}" stroke="#e2e8f0"/>
      <text x="108" y="${y(value) + 6}" text-anchor="end" font-size="18" fill="#64748b">₩${compact(value)}</text>`);
  }
  elements.push(`<line x1="125" x2="1025" y1="${y(0)}" y2="${y(0)}" stroke="#94a3b8"/>`);
  months.forEach((month, i) => {
    const x = 125 + slot * (i + 0.5);
    const label = new Date(`${month.month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    elements.push(`<text x="${x}" y="936" text-anchor="${months.length > 12 ? 'end' : 'middle'}" font-size="${months.length > 12 ? 13 : 17}" ${months.length > 12 ? `transform="rotate(-45 ${x} 936)"` : ''} fill="#64748b">${label}</text>`);
    if (month.value == null) {
      elements.push(`<text x="${x}" y="${y(0) - 12}" text-anchor="middle" font-size="14" fill="#64748b">N/A</text>`);
      return;
    }
    const color = month.value < 0 ? '#dc2626' : '#15803d';
    elements.push(`<rect data-month="${month.month}" x="${x - width / 2}" y="${Math.min(y(0), y(month.value))}" width="${width}" height="${Math.max(2, Math.abs(y(month.value) - y(0)))}" fill="${month.current ? '#ffffff' : color}" stroke="${color}" stroke-width="3" ${month.current ? 'stroke-dasharray="1 7" stroke-linecap="round"' : ''}/>`);
    if (months.length <= 12) elements.push(`<text x="${x}" y="${month.value < 0 ? y(month.value) + 23 : y(month.value) - 12}" text-anchor="middle" font-size="15" fill="#334155">${compact(month.value)}${month.estimated ? ' est.' : ''}</text>`);
  });
  if (months.some(month => month.pending)) elements.push('<text x="48" y="1000" font-size="18" fill="#64748b">N/A: monthly profit is pending complete financial data.</text>');
  return elements.join('\n');
}

function buildProfitChartSvg(historyPoints, reportDate) {
  const firstUsableIndex = historyPoints.findIndex(point => point.value != null);
  const points = firstUsableIndex < 0 ? historyPoints : historyPoints.slice(firstUsableIndex);
  const known = points.filter(point => point.value != null);
  const last = points.at(-1);
  const values = known.map(point => point.value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = Math.max(max - min, 1);
  const low = min - span * 0.12;
  const high = max + span * 0.12;
  const x = i => 125 + i / Math.max(points.length - 1, 1) * 900;
  const y = value => 430 - (value - low) / (high - low) * 265;
  const money = value => `${value < 0 ? '-' : ''}₩${Math.round(Math.abs(value)).toLocaleString('en-US')}`;
  const axisScale = Math.max(Math.abs(min), Math.abs(max)) >= 1000000 ? 1000000 : 1;
  const axisMoney = value => axisScale === 1 ? money(value)
    : `${value < 0 ? '-' : ''}₩${(Math.abs(value) / axisScale).toFixed(1)}m`;
  const elements = [];
  for (let i = 0; i <= 4; i += 1) {
    const value = min + (max - min || 1) * i / 4;
    elements.push(`<line x1="125" x2="1025" y1="${y(value)}" y2="${y(value)}" stroke="#e2e8f0"/>
      <text x="108" y="${y(value) + 6}" text-anchor="end" font-size="18" fill="#64748b">${axisMoney(value)}</text>`);
  }
  let linePath = '';
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point.value == null) continue;
    const previous = points[i - 1];
    linePath += `${previous?.value != null ? 'L' : 'M'}${x(i)},${y(point.value)} `;
    if (i === 0 || i === known.length - 1) elements.push(`<circle cx="${x(i)}" cy="${y(point.value)}" r="5" fill="#15803d"/>`);
  }
  if (linePath) elements.push(`<path d="${linePath}" fill="none" stroke="#15803d" stroke-width="4"/>`);
  const weekStart = date => shiftDate(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
  const weekTicks = points.map((point, i) => ({ i, week: weekStart(point.date) }))
    .filter((tick, i, all) => i === 0 || tick.week !== all[i - 1].week);
  const tickStride = Math.max(1, Math.ceil(weekTicks.length / 6));
  for (const { i, week } of weekTicks.filter((_, index) => index % tickStride === 0)) {
    elements.push(`<text x="${x(i)}" y="461" text-anchor="${i === 0 ? 'start' : 'middle'}" font-size="18" fill="#64748b">${(i === 0 ? points[0].date : week).slice(5)}</text>`);
  }
  const headline = last.value == null ? 'Pending complete financial data' : `${money(last.value)}${last.estimated ? '  estimated' : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="1040">
    <rect width="1100" height="1040" rx="24" fill="#ffffff"/>
    <g font-family="DejaVu Sans, Arial, sans-serif">
      <text x="48" y="50" font-size="27" font-weight="bold" fill="#0f172a">${firstUsableIndex < 0 ? 'Cumulative net profit' : `Cumulative profit since ${points[0].date}`}</text>
      <text x="48" y="84" font-size="18" fill="#64748b">Through ${reportDate} (KST)${firstUsableIndex > 0 ? ' · Earlier history excluded: incomplete financial data' : ''}</text>
      <text x="48" y="128" font-size="30" font-weight="bold" fill="#0f172a">${headline}</text>
      ${elements.join('\n')}
      ${last.pending ? '<text x="48" y="520" font-size="18" fill="#64748b">Line stops where financial data is incomplete.</text>' : ''}
      <line x1="48" x2="1052" y1="546" y2="546" stroke="#e2e8f0"/>
      ${buildMonthlyProfitSvg(buildMonthlyProfitSeries(historyPoints, reportDate))}
    </g></svg>`;
}

async function buildDailyProfitChart(data, reportDate) {
  for (const key of ['imweb', 'cogs', 'metaInsights']) {
    const source = data.sources?.[key];
    if (source?.stale || source?.status === 'error' || source?.hasData === false) {
      throw new Error(`${key} source is stale or unavailable; profit chart unavailable`);
    }
  }
  const auditStatus = data.sourceAudit?.reconciliation?.status;
  if (auditStatus && auditStatus !== 'reconciled') {
    throw new Error('Financial sources do not reconcile; profit chart unavailable');
  }
  const dates = buildFinancialProjection(data).dailyMerged.map(row => row.date)
    .filter(date => date <= reportDate).sort();
  if (!dates.length) throw new Error('No recorded financial history for chart');
  const startDate = dates[0];
  const [historicalFx, paywayFinancials] = await Promise.all([
    require('./fxService').getUsdToKrwRatesForRange(startDate, reportDate),
    require('./paywayFinancialService').getPaywayFinancialSummary({ startDate, endDate: reportDate }),
  ]);
  if (paywayFinancials.stale || paywayFinancials.error) {
    throw new Error('Payway fees are stale or unavailable; profit chart unavailable');
  }
  const projection = buildFinancialProjection(data, {
    usdToKrwRatesByDate: historicalFx?.ratesByDate || null,
  });
  const allDates = [];
  for (let date = startDate; date <= reportDate; date = shiftDate(date, 1)) allDates.push(date);
  // Lazy import avoids the calendar → scheduler → Telegram dependency cycle.
  const { buildSummaryFinancialDays } = require('./calendarService');
  const days = buildSummaryFinancialDays(projection, allDates, paywayFinancials);
  const points = buildCumulativeProfitSeries(data, reportDate, days);
  if (!points.length) throw new Error('No recorded financial history for chart');
  const svg = buildProfitChartSvg(points, reportDate);
  const png = await require('sharp')(Buffer.from(svg)).png().toBuffer();
  return {
    png,
    pending: points.some(point => point.pending || point.estimated),
    fingerprint: crypto.createHash('sha256').update(svg).digest('hex'),
  };
}

module.exports = { buildCumulativeProfitSeries, buildMonthlyProfitSeries, buildProfitChartSvg, buildDailyProfitChart };
