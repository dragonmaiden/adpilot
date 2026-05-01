const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('dashboard opens to the combined summary page by default', () => {
  assert.match(indexHtml, /<a href="#" class="nav-item active" data-page="calendar">/);
  assert.match(indexHtml, /data-i18n="nav\.calendar">Summary/);
  assert.match(indexHtml, /<section class="page active" data-page="calendar">/);
  assert.doesNotMatch(indexHtml, /data-page="analytics"/);
  assert.match(indexHtml, /summary-profit-visuals/);
});
