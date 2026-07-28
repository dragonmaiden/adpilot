const paywayClient = require('../modules/paywayClient');
const { summarizePaywayTransactions } = require('../domain/paywayFinancials');

const CACHE_TTL_MS = 30 * 1000;
const cache = new Map();
const pending = new Map();

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function validateRange(startDate, endDate) {
  if (!isDateKey(startDate) || !isDateKey(endDate) || startDate > endDate) {
    throw new Error('Payway financial range requires valid startDate and endDate values');
  }
}

function getCacheKey(startDate, endDate) {
  return `${startDate}:${endDate}`;
}

function isFresh(entry, nowMs) {
  return entry && nowMs - entry.cachedAtMs < CACHE_TTL_MS;
}

function pruneStaleEntries(nowMs, preservedKey) {
  for (const [key, entry] of cache.entries()) {
    if (key !== preservedKey && !isFresh(entry, nowMs)) {
      cache.delete(key);
    }
  }
}

function findFreshContainingEntry(startDate, endDate, nowMs) {
  let bestMatch = null;

  for (const entry of cache.values()) {
    if (!isFresh(entry, nowMs)) {
      continue;
    }

    if (
      entry.startDate <= startDate
      && entry.endDate >= endDate
      && Array.isArray(entry.transactions)
    ) {
      if (!bestMatch || entry.cachedAtMs > bestMatch.cachedAtMs) {
        bestMatch = entry;
      }
    }
  }

  return bestMatch;
}

function buildSummary(transactions, startDate, endDate, fetchedAt = new Date().toISOString()) {
  return {
    ready: true,
    ...summarizePaywayTransactions(transactions, { startDate, endDate }),
    fetchedAt,
    stale: false,
    error: null,
  };
}

async function fetchSummary(startDate, endDate) {
  const transactions = await paywayClient.fetchPaymentHistory({ startDate, endDate });
  return {
    transactions,
    summary: buildSummary(transactions, startDate, endDate),
  };
}

async function getPaywayFinancialSummary({
  startDate,
  endDate,
  refresh = false,
} = {}) {
  validateRange(startDate, endDate);

  if (!paywayClient.isConfigured()) {
    return {
      ready: false,
      source: 'payway',
      dateBasis: 'payment_transaction_kst',
      range: { start: startDate, end: endDate },
      totals: null,
      daily: [],
      fetchedAt: null,
      stale: false,
      error: 'Payway is not configured',
    };
  }

  const key = getCacheKey(startDate, endDate);
  const nowMs = Date.now();
  const cached = cache.get(key);
  if (!refresh && isFresh(cached, nowMs)) {
    return cached.summary;
  }

  pruneStaleEntries(nowMs, key);
  const containingEntry = !refresh
    ? findFreshContainingEntry(startDate, endDate, nowMs)
    : null;
  if (containingEntry) {
    const summary = buildSummary(
      containingEntry.transactions,
      startDate,
      endDate,
      containingEntry.summary.fetchedAt
    );
    cache.set(key, {
      ...containingEntry,
      startDate,
      endDate,
      summary,
    });
    return summary;
  }

  if (pending.has(key)) {
    return pending.get(key);
  }

  const request = fetchSummary(startDate, endDate)
    .then(({ transactions, summary }) => {
      cache.set(key, {
        startDate,
        endDate,
        cachedAtMs: Date.now(),
        transactions,
        summary,
      });
      return summary;
    })
    .catch(err => {
      if (cached?.summary) {
        return {
          ...cached.summary,
          stale: true,
          error: err.message,
        };
      }

      return {
        ready: false,
        source: 'payway',
        dateBasis: 'payment_transaction_kst',
        range: { start: startDate, end: endDate },
        totals: null,
        daily: [],
        fetchedAt: null,
        stale: false,
        error: err.message,
      };
    })
    .finally(() => pending.delete(key));

  pending.set(key, request);
  return request;
}

function clearCache() {
  cache.clear();
  pending.clear();
}

module.exports = {
  getPaywayFinancialSummary,
  clearCache,
};
