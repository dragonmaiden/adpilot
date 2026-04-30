const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.join(__dirname, '..', 'public', 'app.js');
const STYLE_PATH = path.join(__dirname, '..', 'public', 'style.css');

const appJs = fs.readFileSync(APP_PATH, 'utf8');
const css = fs.readFileSync(STYLE_PATH, 'utf8');

test('profit movement exposes true net profit as a hoverable line series', () => {
  assert.match(
    appJs,
    /label:\s*'True Net Profit'[\s\S]*borderColor:\s*c\.netProfitLine[\s\S]*backgroundColor:\s*c\.netProfitLine[\s\S]*pointStyle:\s*'line'/
  );
  assert.match(
    appJs,
    /interaction:\s*\{\s*[\r\n]\s*mode:\s*'index',\s*[\r\n]\s*intersect:\s*false/
  );
  assert.match(
    appJs,
    /tooltip:\s*\{[\s\S]*mode:\s*'index'[\s\S]*label:\s*function\(ctx\)\s*\{[\s\S]*formatSignedChartKrw\(ctx\.parsed\.y\)/
  );
  assert.match(appJs, /tooltip:\s*\{[\s\S]*backgroundColor:\s*'#111827'[\s\S]*bodyColor:\s*'#ffffff'/);
});

test('positive bar charts share the deep green profit palette', () => {
  assert.match(appJs, /darkGreenFill:\s*'rgba\(22, 101, 52, 0\.72\)'/);
  assert.match(appJs, /label:\s*'Revenue \(₩\)'[\s\S]*backgroundColor:\s*c\.darkGreenFill/);
  assert.match(appJs, /label:\s*'Gross Revenue'[\s\S]*backgroundColor:\s*c\.darkGreenFill/);
  assert.match(appJs, /label:\s*'Orders'[\s\S]*backgroundColor:\s*c\.darkGreenFill/);
});

test('refund-rate labels use dark text instead of warning yellow', () => {
  assert.match(appJs, /ctx\.fillStyle\s*=\s*c\.netProfitLine\s*\|\|\s*'#111827'/);
});

test('compact section headers stay visually tied to the card below', () => {
  assert.match(
    css,
    /\.section-head-compact\s*\{[\s\S]*margin-top:\s*var\(--space-5\);[\s\S]*margin-bottom:\s*var\(--space-3\);/
  );
});
