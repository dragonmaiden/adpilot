const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const API_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'api.js');

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) || '';
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function loadApiClient(payload) {
  const warnings = [];
  const requests = [];
  const script = fs.readFileSync(API_JS_PATH, 'utf8');
  const context = {
    AbortController,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console: {
      warn: (...args) => warnings.push(args.join(' ')),
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => payload,
      };
    },
    window: {
      AdPilotLive: {},
      location: {
        origin: 'http://127.0.0.1:3001',
        reload() {},
      },
      localStorage: createStorage(),
      sessionStorage: createStorage(),
      prompt: () => '',
      setTimeout,
      clearTimeout,
    },
  };

  vm.runInNewContext(script, context, { filename: API_JS_PATH });
  return {
    api: context.window.AdPilotLive.api,
    warnings,
    requests,
  };
}

test('live API client accepts valid overview payloads and attaches a timeout signal', async () => {
  const { api, requests } = loadApiClient({
    apiVersion: 'v1',
    ready: true,
    kpis: {},
    charts: { dailyMerged: [] },
    dataSources: {},
    sourceAudit: null,
  });

  const data = await api.fetchOverview();

  assert.equal(data.ready, true);
  assert.equal(requests[0].url, 'http://127.0.0.1:3001/api/overview');
  assert.ok(requests[0].options.signal);
});

test('live API client rejects malformed analytics payloads before rendering can coerce them to zeroes', async () => {
  const { api, warnings } = loadApiClient({
    apiVersion: 'v1',
    charts: { dailyMerged: {} },
    profitAnalysis: { waterfall: [] },
    dataSources: {},
  });

  const data = await api.fetchAnalytics();

  assert.equal(data, null);
  assert.ok(warnings.some(message => message.includes('API contract mismatch')));
  assert.ok(warnings.some(message => message.includes('analytics')));
});

test('live API client rejects unversioned financial payloads', async () => {
  const { api, warnings } = loadApiClient({
    ready: true,
    kpis: {},
    charts: { dailyMerged: [] },
    dataSources: {},
  });

  const data = await api.fetchOverview();

  assert.equal(data, null);
  assert.ok(warnings.some(message => message.includes('unexpected apiVersion undefined')));
});

test('live API client rejects source audit shape drift on calendar payloads', async () => {
  const { api, warnings } = loadApiClient({
    apiVersion: 'v1',
    ready: true,
    viewport: {},
    calendarDays: [],
    orderPatterns: { range: {}, weekday: [], hourly: [] },
    selection: { days: [] },
    sourceAudit: 'mismatch',
  });

  const data = await api.fetchCalendarAnalysis({
    visibleStart: '2026-04-01',
    visibleEnd: '2026-04-30',
    selectionStart: '2026-04-30',
    selectionEnd: '2026-04-30',
  });

  assert.equal(data, null);
  assert.ok(warnings.some(message => message.includes('sourceAudit must be an object or null')));
});

test('live API client rejects calendar payloads without all-time order patterns', async () => {
  const { api, warnings } = loadApiClient({
    apiVersion: 'v1',
    ready: true,
    viewport: {},
    calendarDays: [],
    selection: { days: [] },
    sourceAudit: null,
  });

  const data = await api.fetchCalendarAnalysis({
    visibleStart: '2026-04-01',
    visibleEnd: '2026-04-30',
    selectionStart: '2026-04-30',
    selectionEnd: '2026-04-30',
  });

  assert.equal(data, null);
  assert.ok(warnings.some(message => message.includes('missing orderPatterns object')));
});
