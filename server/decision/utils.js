function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function ratio(numerator, denominator, fallback = 0) {
  const safeDenominator = asNumber(denominator, 0);
  if (!safeDenominator) return fallback;
  return asNumber(numerator, 0) / safeDenominator;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(asNumber(value, 0) * factor) / factor;
}

module.exports = {
  asNumber,
  clamp,
  uniqueStrings,
  ratio,
  round,
};
