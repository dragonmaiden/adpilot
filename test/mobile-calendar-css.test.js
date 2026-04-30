const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STYLE_PATH = path.join(__dirname, '..', 'public', 'style.css');

test('mobile calendar values wrap instead of clipping inside the seven-column grid', () => {
  const css = fs.readFileSync(STYLE_PATH, 'utf8');

  assert.match(
    css,
    /@media \(max-width: 480px\)[\s\S]*\.calendar-day-label,\s*[\r\n]\s*\.calendar-day-revenue,\s*[\r\n]\s*\.calendar-day-profit,\s*[\r\n]\s*\.calendar-day-orders\s*\{[\s\S]*white-space:\s*normal;[\s\S]*overflow-wrap:\s*anywhere;/
  );
  assert.match(
    css,
    /@media \(max-width: 360px\)[\s\S]*\.calendar-day-revenue\s*\{[\s\S]*font-size:\s*0\.62rem;/
  );
  assert.match(
    css,
    /@media \(max-width: 480px\)[\s\S]*\.calendar-mini-badge\s*\{[\s\S]*white-space:\s*normal;[\s\S]*overflow-wrap:\s*anywhere;/
  );
});
