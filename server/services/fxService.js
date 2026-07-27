const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtime/paths');
const { shiftDate } = require('../domain/time');

const FX_CACHE_FILE = path.join(runtimePaths.dataDir, 'fx_latest.json');
const FX_API_ORIGIN = 'https://api.frankfurter.app';
const FX_API_URL = `${FX_API_ORIGIN}/latest?from=USD&to=KRW`;
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FX_HISTORY_LOOKBACK_DAYS = 7;

let memoryCache = null;
let inflightRequest = null;
const historicalMemoryCache = new Map();
const historicalInflightRequests = new Map();

function isValidDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function enumerateDateKeys(startDate, endDate) {
  const dates = [];
  let cursor = startDate;

  while (cursor && cursor <= endDate) {
    dates.push(cursor);
    cursor = shiftDate(cursor, 1);
  }

  return dates;
}

function loadCache() {
  if (memoryCache) return memoryCache;

  try {
    if (!fs.existsSync(FX_CACHE_FILE)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(FX_CACHE_FILE, 'utf8'));
    memoryCache = parsed && typeof parsed === 'object' ? parsed : null;
    return memoryCache;
  } catch (err) {
    console.warn('[FX] Failed to read cache:', err.message);
    return null;
  }
}

function saveCache(cache) {
  memoryCache = cache;
  try {
    fs.writeFileSync(FX_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn('[FX] Failed to write cache:', err.message);
  }
}

function isFresh(cache) {
  if (!cache?.fetchedAt) return false;
  const fetchedAt = new Date(cache.fetchedAt).getTime();
  if (!Number.isFinite(fetchedAt)) return false;
  return (Date.now() - fetchedAt) < FX_CACHE_TTL_MS;
}

function buildDailyUsdToKrwRates(payload, startDate, endDate, fetchedAt = new Date().toISOString()) {
  if (!isValidDateKey(startDate) || !isValidDateKey(endDate) || startDate > endDate) {
    throw new Error('FX history requires a valid ascending date range');
  }
  if (payload?.base !== 'USD' || !payload?.rates || typeof payload.rates !== 'object') {
    throw new Error('FX API returned an invalid USD/KRW history');
  }

  const publishedRates = Object.entries(payload.rates)
    .map(([rateDate, quotes]) => ({
      rateDate,
      usdToKrwRate: Number(quotes?.KRW),
    }))
    .filter(entry =>
      isValidDateKey(entry.rateDate)
      && Number.isFinite(entry.usdToKrwRate)
      && entry.usdToKrwRate > 0
    )
    .sort((left, right) => left.rateDate.localeCompare(right.rateDate));

  let publishedIndex = 0;
  let activeRate = null;
  const ratesByDate = {};

  for (const date of enumerateDateKeys(startDate, endDate)) {
    while (
      publishedIndex < publishedRates.length
      && publishedRates[publishedIndex].rateDate <= date
    ) {
      activeRate = publishedRates[publishedIndex];
      publishedIndex += 1;
    }

    if (activeRate) {
      ratesByDate[date] = {
        usdToKrwRate: activeRate.usdToKrwRate,
        rateDate: activeRate.rateDate,
      };
    }
  }

  if (Object.keys(ratesByDate).length === 0) {
    throw new Error('FX API returned no USD/KRW rates for the requested range');
  }

  return {
    base: 'USD',
    quote: 'KRW',
    source: 'frankfurter.app',
    rangeStart: startDate,
    rangeEnd: endDate,
    fetchedAt,
    stale: false,
    ratesByDate,
  };
}

async function fetchLatestUsdToKrwRate() {
  const response = await fetch(FX_API_URL, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`FX API ${response.status}: ${response.statusText}`);
  }

  const payload = await response.json();
  const rate = Number(payload?.rates?.KRW || 0);
  const rateDate = String(payload?.date || '').trim();

  if (!Number.isFinite(rate) || rate <= 0 || !rateDate) {
    throw new Error('FX API returned an invalid USD/KRW rate');
  }

  const cache = {
    base: 'USD',
    quote: 'KRW',
    source: 'frankfurter.app',
    usdToKrwRate: rate,
    rateDate,
    fetchedAt: new Date().toISOString(),
  };

  saveCache(cache);
  return cache;
}

async function fetchUsdToKrwRatesForRange(startDate, endDate) {
  const requestStart = shiftDate(startDate, -FX_HISTORY_LOOKBACK_DAYS);
  const response = await fetch(
    `${FX_API_ORIGIN}/${requestStart}..${endDate}?from=USD&to=KRW`,
    {
      headers: {
        accept: 'application/json',
      },
    }
  );

  if (!response.ok) {
    throw new Error(`FX API ${response.status}: ${response.statusText}`);
  }

  return buildDailyUsdToKrwRates(
    await response.json(),
    startDate,
    endDate
  );
}

async function getLatestUsdToKrwRate() {
  const cached = loadCache();
  if (cached && isFresh(cached)) {
    return cached;
  }

  if (!inflightRequest) {
    inflightRequest = (async () => {
      try {
        return await fetchLatestUsdToKrwRate();
      } catch (err) {
        const fallback = loadCache();
        if (fallback?.usdToKrwRate) {
          console.warn('[FX] Using cached USD/KRW rate after fetch failure:', err.message);
          return fallback;
        }
        throw err;
      } finally {
        inflightRequest = null;
      }
    })();
  }

  return inflightRequest;
}

async function getUsdToKrwRatesForRange(startDate, endDate) {
  if (!isValidDateKey(startDate) || !isValidDateKey(endDate) || startDate > endDate) {
    throw new Error('FX history requires a valid ascending date range');
  }

  const cacheKey = `${startDate}:${endDate}`;
  const cached = historicalMemoryCache.get(cacheKey);
  if (cached && isFresh(cached)) {
    return cached;
  }

  if (!historicalInflightRequests.has(cacheKey)) {
    const request = fetchUsdToKrwRatesForRange(startDate, endDate)
      .then(result => {
        historicalMemoryCache.set(cacheKey, result);
        return result;
      })
      .finally(() => {
        historicalInflightRequests.delete(cacheKey);
      });
    historicalInflightRequests.set(cacheKey, request);
  }

  return historicalInflightRequests.get(cacheKey);
}

module.exports = {
  getLatestUsdToKrwRate,
  getUsdToKrwRatesForRange,
  buildDailyUsdToKrwRates,
};
