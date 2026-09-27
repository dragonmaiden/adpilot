const { shiftDate } = require('../domain/time');
const { buildFinancialProjection } = require('./financialProjectionService');
const fxService = require('./fxService');
const paywayFinancialService = require('./paywayFinancialService');

function dateKeys(startDate, endDate) {
  const dates = [];
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) dates.push(date);
  return dates;
}

async function getReportFinancialDays(data, startDate, endDate) {
  const [historicalFx, paywayFinancials] = await Promise.all([
    fxService.getUsdToKrwRatesForRange(startDate, endDate),
    paywayFinancialService.getPaywayFinancialSummary({ startDate, endDate }),
  ]);
  if (!historicalFx?.ratesByDate || historicalFx.stale) {
    throw new Error('Historical FX is unavailable');
  }
  if (!paywayFinancials?.ready || paywayFinancials.stale || paywayFinancials.error
    || paywayFinancials.totals?.feesComplete !== true) {
    throw new Error('Actual Payway fees are unavailable or incomplete');
  }

  const projection = buildFinancialProjection(data, {
    usdToKrwRatesByDate: historicalFx.ratesByDate,
  });
  // Lazy import avoids calendar → scheduler → Telegram dependency cycle.
  const { buildSummaryFinancialDays } = require('./calendarService');
  const days = buildSummaryFinancialDays(projection, dateKeys(startDate, endDate), paywayFinancials);
  if (days.some(day => day.fxStale || !day.paymentFeesComplete)) {
    throw new Error('Financial day has incomplete FX or Payway fees');
  }
  return { projection, days };
}

module.exports = { getReportFinancialDays };
