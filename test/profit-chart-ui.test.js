const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'public', 'app.js');
const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const STYLE_PATH = path.join(__dirname, '..', 'public', 'style.css');
const UTILS_PATH = path.join(__dirname, '..', 'public', 'utils.js');
const SHARED_PATH = path.join(__dirname, '..', 'public', 'live', 'shared.js');
const CALENDAR_JS_PATH = path.join(__dirname, '..', 'public', 'live', 'pages', 'calendar.js');
const LIVE_PERFORMANCE_SERVICE_PATH = path.join(
  __dirname,
  '..',
  'server',
  'services',
  'livePerformanceService.js'
);

const appJs = fs.readFileSync(APP_PATH, 'utf8');
const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
const css = fs.readFileSync(STYLE_PATH, 'utf8');
const utilsJs = fs.readFileSync(UTILS_PATH, 'utf8');
const sharedJs = fs.readFileSync(SHARED_PATH, 'utf8');
const calendarJs = fs.readFileSync(CALENDAR_JS_PATH, 'utf8');
const livePerformanceServiceJs = fs.readFileSync(LIVE_PERFORMANCE_SERVICE_PATH, 'utf8');

test('summary removes the retired chart runtime and canvases', () => {
  assert.doesNotMatch(indexHtml, /chart\.js|<canvas/i);
  assert.doesNotMatch(
    indexHtml,
    /profitWaterfallChart|netProfitChart|weekdayChart|hourChart/
  );
  assert.doesNotMatch(appJs, /\bChart\b|initProfitCharts|initAnalyticsCharts/);
});

test('compact section headers stay visually tied to the card below', () => {
  assert.match(
    css,
    /\.section-head-compact\s*\{[\s\S]*margin-top:\s*var\(--space-5\);[\s\S]*margin-bottom:\s*var\(--space-3\);/
  );
});

test('KRW display helpers render full whole amounts instead of K or M abbreviations', () => {
  const displaySources = [utilsJs, sharedJs, calendarJs, livePerformanceServiceJs].join('\n');

  assert.doesNotMatch(displaySources, /toFixed\([^)]*\)\s*\+\s*['"`][KMk]/);
  assert.doesNotMatch(
    displaySources,
    /Math\.round\([^)]*\/\s*1_?000\)[\s\S]{0,80}['"`][KMk]/
  );
  assert.doesNotMatch(displaySources, /\$\{[^}]*\/\s*1_?000_?000[^}]*\}[KMk]/);
  assert.doesNotMatch(displaySources, /\$\{[^}]*\/\s*1_?000[^}]*\}[KMk]/);
});
