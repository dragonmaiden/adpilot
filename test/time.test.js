const test = require('node:test');
const assert = require('node:assert/strict');

test('KST date and hour conversion reuse one formatter across transaction batches', t => {
  const modulePath = require.resolve('../server/domain/time');
  const previous = require.cache[modulePath];
  const OriginalFormatter = Intl.DateTimeFormat;
  let constructions = 0;
  t.mock.method(Intl, 'DateTimeFormat', function (...args) {
    constructions++;
    return new OriginalFormatter(...args);
  });
  delete require.cache[modulePath];
  t.after(() => {
    if (previous) require.cache[modulePath] = previous;
    else delete require.cache[modulePath];
  });
  const { formatDateInTimeZone, getHourInTimeZone } = require(modulePath);
  for (let index = 0; index < 100; index++) {
    assert.equal(formatDateInTimeZone('2026-12-31T15:00:00Z'), '2027-01-01');
    assert.equal(getHourInTimeZone('2026-12-31T15:00:00Z'), 0);
    assert.equal(formatDateInTimeZone('2026-12-31T14:59:59Z'), '2026-12-31');
  }
  assert.equal(constructions, 1);
});

test('timezone conversion retains explicit zones, DST boundaries, and invalid-input errors', () => {
  const { formatDateInTimeZone, getHourInTimeZone } = require('../server/domain/time');
  for (const zone of ['Asia/Seoul', 'UTC', 'America/New_York']) {
    for (const date of ['2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T06:00:00Z']) {
      const expected = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
      }).formatToParts(new Date(date)).map(part => [part.type, part.value]));
      assert.equal(formatDateInTimeZone(date, zone), `${expected.year}-${expected.month}-${expected.day}`);
      assert.equal(getHourInTimeZone(date, zone), Number(expected.hour));
    }
  }
  assert.throws(() => formatDateInTimeZone('invalid'), RangeError);
  assert.throws(() => formatDateInTimeZone(new Date(), 'Invalid/Zone'), RangeError);
});
