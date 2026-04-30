const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'public', 'index.html');
const indexHtml = fs.readFileSync(INDEX_HTML_PATH, 'utf8');

const EXPECTED_GROUP_OPTIONS = ['7d', '14d', '30d', 'all'];
const EXPECTED_DEFAULTS = {
  'profit-structure': 'all',
  'order-patterns': 'all',
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getGroupMarkup(group) {
  const pattern = new RegExp(
    `<div class="range-switch"[^>]*data-series-window-group="${escapeRegExp(group)}"[^>]*>([\\s\\S]*?)</div>`
  );
  const match = indexHtml.match(pattern);
  assert.ok(match, `Expected series window group "${group}" to exist in public/index.html`);
  return match[1];
}

function getButtonValues(markup) {
  return Array.from(markup.matchAll(/data-series-window-value="([^"]+)"/g), match => match[1]);
}

function getActiveValue(markup) {
  const match = markup.match(/class="[^"]*\bis-active\b[^"]*"[^>]*data-series-window-value="([^"]+)"/);
  return match ? match[1] : null;
}

test('each series window group exposes the shared timeframe options in a consistent order', () => {
  Object.keys(EXPECTED_DEFAULTS).forEach(group => {
    const markup = getGroupMarkup(group);
    assert.deepEqual(
      getButtonValues(markup),
      EXPECTED_GROUP_OPTIONS,
      `Expected ${group} to show ${EXPECTED_GROUP_OPTIONS.join(', ')}`
    );
  });
});

test('each series window group starts with the same default active option as the shared window state', () => {
  Object.entries(EXPECTED_DEFAULTS).forEach(([group, expectedDefault]) => {
    const markup = getGroupMarkup(group);
    assert.equal(
      getActiveValue(markup),
      expectedDefault,
      `Expected ${group} to default to ${expectedDefault}`
    );
  });
});
