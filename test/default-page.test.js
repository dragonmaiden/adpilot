const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('dashboard opens to calendar page by default', () => {
  assert.match(indexHtml, /<a href="#" class="nav-item active" data-page="calendar">/);
  assert.match(indexHtml, /<a href="#" class="nav-item" data-page="analytics">/);
  assert.match(indexHtml, /<section class="page active" data-page="calendar">/);
  assert.match(indexHtml, /<section class="page" data-page="analytics">/);
});
