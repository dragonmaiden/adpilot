const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withState(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-telegram-state-'));
  const pathsId = require.resolve('../server/runtime/paths');
  const stateId = require.resolve('../server/modules/telegramState');
  const original = require.cache[pathsId];
  require.cache[pathsId] = { id: pathsId, filename: pathsId, loaded: true, exports: { dataDir } };
  const load = () => {
    delete require.cache[stateId];
    return require(stateId);
  };
  try {
    run(load, path.join(dataDir, 'telegram_state.json'));
  } finally {
    delete require.cache[stateId];
    if (original) require.cache[pathsId] = original;
    else delete require.cache[pathsId];
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('report delivery survives restart and acknowledgment cannot clear a newer correction', () => {
  withState((load, file) => {
    fs.writeFileSync(file, JSON.stringify({ summary: { fingerprint: 'existing' }, dailyReport: {} }));
    const sent = { reportDate: '2026-09-13', status: 'sent', sentAt: '2026-09-13T14:30:00Z', metadata: { telegramMessageId: 99 } };
    load().recordReportDelivery(sent);
    assert.equal(load().getState().dailyReport.reportDate, sent.reportDate);
    assert.equal(load().getState().summary.fingerprint, 'existing');
    assert.equal(load().getState().reportDeliveries[sent.reportDate].metadata.telegramMessageId, 99);
    const corrected = { ...sent, status: 'corrected', payload: 'updated' };
    load().recordReportDelivery(corrected);
    load().markReportDeliverySynced(sent);
    assert.equal(load().getState().reportDeliveries[sent.reportDate].ledgerPending, true);
    load().markReportDeliverySynced(corrected);
    assert.equal(load().getState().reportDeliveries[sent.reportDate].ledgerPending, false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test('failed atomic write leaves the previous tracking record intact', () => {
  withState((load, file) => {
    const state = load();
    state.markDailyReportSent({ reportDate: '2026-09-12' });
    const previous = fs.readFileSync(file, 'utf8');
    const mock = test.mock.method(fs, 'renameSync', () => { throw new Error('disk failure'); });
    try {
      assert.throws(() => state.recordReportDelivery({ reportDate: '2026-09-13', status: 'sent' }), /disk failure/);
      assert.equal(fs.readFileSync(file, 'utf8'), previous);
    } finally {
      mock.mock.restore();
    }
  });
});

test('corrupt tracking fails closed instead of resetting history and resending reports', () => {
  withState((load, file) => {
    fs.writeFileSync(file, '{broken');
    assert.throws(() => load().getState(), SyntaxError);
    assert.throws(() => load().markSummarySent({ fingerprint: 'new' }), SyntaxError);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  });
});
