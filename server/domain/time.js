const KST_TIME_ZONE = 'Asia/Seoul';

function getDatePartsInTimeZone(dateInput, timeZone = KST_TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(dateInput));
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  }

  return values;
}

function formatDateInTimeZone(dateInput, timeZone = KST_TIME_ZONE) {
  const parts = getDatePartsInTimeZone(dateInput, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getHourInTimeZone(dateInput, timeZone = KST_TIME_ZONE) {
  const parts = getDatePartsInTimeZone(dateInput, timeZone);
  return Number.parseInt(parts.hour || '0', 10);
}

function getTodayInTimeZone(timeZone = KST_TIME_ZONE) {
  return formatDateInTimeZone(new Date(), timeZone);
}

function shiftDate(dateKey, deltaDays) {
  if (!dateKey) return null;

  const [year, month, day] = String(dateKey).split('-').map(value => Number.parseInt(value, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

module.exports = {
  KST_TIME_ZONE,
  formatDateInTimeZone,
  getHourInTimeZone,
  getTodayInTimeZone,
  shiftDate,
};
