const { extractPositiveFieldValues } = require('./metrics');

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, digits = 2) {
  return Number.parseFloat((Number.isFinite(value) ? value : 0).toFixed(digits));
}

function buildFatigueSnapshot(insights) {
  const rows = Array.isArray(insights) ? insights : [];
  const ctrs = extractPositiveFieldValues(rows, 'ctr');
  const cpms = extractPositiveFieldValues(rows, 'cpm');
  const frequencies = extractPositiveFieldValues(rows, 'frequency');

  const peakCTR = ctrs.length > 0 ? Math.max(...ctrs) : 0;
  const lastCTR = ctrs.length > 0 ? ctrs[ctrs.length - 1] : 0;
  const recentCTR = ctrs.length >= 3 ? average(ctrs.slice(-3)) : lastCTR;
  const avgCTR = average(ctrs);
  const lastCPM = cpms.length > 0 ? cpms[cpms.length - 1] : 0;
  const recentCPM = cpms.length >= 3 ? average(cpms.slice(-3)) : lastCPM;
  const avgCPM = average(cpms);
  const lastFrequency = frequencies.length > 0 ? frequencies[frequencies.length - 1] : 0;
  const avgFrequency = average(frequencies);

  const ctrDecayPercent = peakCTR > 0
    ? ((peakCTR - recentCTR) / peakCTR) * 100
    : 0;
  const cpmRisePercent = avgCPM > 0
    ? ((recentCPM - avgCPM) / avgCPM) * 100
    : 0;

  return {
    daysOfData: rows.length,
    peakCTR: round(peakCTR),
    lastCTR: round(lastCTR),
    recentCTR: round(recentCTR),
    avgCTR: round(avgCTR),
    lastCPM: round(lastCPM),
    recentCPM: round(recentCPM),
    avgCPM: round(avgCPM),
    lastFrequency: round(lastFrequency),
    avgFrequency: round(avgFrequency),
    ctrDecayPercent: round(ctrDecayPercent, 1),
    cpmRisePercent: round(cpmRisePercent, 1),
  };
}

function classifyFatigue(snapshot, options = {}) {
  const {
    frequencyThreshold = 4,
    ctrDecayPercent = 30,
    cpmRisePercent = 40,
    minDataDays = 3,
  } = options;

  const daysOfData = Number(snapshot?.daysOfData || 0);
  const highFrequency = Number(snapshot?.lastFrequency || 0) >= frequencyThreshold;
  const significantDecay = Number(snapshot?.ctrDecayPercent || 0) >= ctrDecayPercent;
  const moderateDecay = Number(snapshot?.ctrDecayPercent || 0) >= Math.max(ctrDecayPercent * 0.66, 15);
  const cpmPressure = Number(snapshot?.cpmRisePercent || 0) >= cpmRisePercent;

  if (daysOfData < minDataDays) {
    return {
      status: 'healthy',
      flags: { highFrequency: false, ctrDecay: false, cpmPressure: false },
      summary: `Learning phase — ${daysOfData} day${daysOfData === 1 ? '' : 's'} of delivery so far.`,
    };
  }

  if (highFrequency && significantDecay) {
    return {
      status: 'danger',
      flags: { highFrequency: true, ctrDecay: true, cpmPressure },
      summary: `Frequency ${snapshot.lastFrequency.toFixed(1)} with CTR down ${snapshot.ctrDecayPercent.toFixed(0)}% from peak.`,
    };
  }

  if (highFrequency || moderateDecay || cpmPressure) {
    return {
      status: 'warning',
      flags: { highFrequency, ctrDecay: moderateDecay, cpmPressure },
      summary: highFrequency
        ? `Audience pressure rising at ${snapshot.lastFrequency.toFixed(1)} frequency.`
        : moderateDecay
        ? `CTR is down ${snapshot.ctrDecayPercent.toFixed(0)}% from peak.`
        : `Recent CPM is up ${snapshot.cpmRisePercent.toFixed(0)}% versus average.`,
    };
  }

  return {
    status: 'healthy',
    flags: { highFrequency: false, ctrDecay: false, cpmPressure: false },
    summary: `Stable delivery — CTR ${snapshot.recentCTR.toFixed(2)}%, frequency ${snapshot.lastFrequency.toFixed(1)}.`,
  };
}

module.exports = {
  buildFatigueSnapshot,
  classifyFatigue,
};
