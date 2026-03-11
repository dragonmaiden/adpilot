const fs = require('fs');
const path = require('path');
const runtimePaths = require('../runtime/paths');

const FX_CACHE_FILE = path.join(runtimePaths.dataDir, 'fx_latest.json');
const FX_API_URL = 'https://api.frankfurter.app/latest?from=USD&to=KRW';
const FX_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let memoryCache = null;
let inflightRequest = null;

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

module.exports = {
  getLatestUsdToKrwRate,
};
