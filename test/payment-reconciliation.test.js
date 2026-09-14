const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { latestPaymentAuditSlot, paymentAuditStart, reconcilePayments, buildPaymentAuditMessage } = require('../server/domain/paymentReconciliation');
const { createPaymentReconciliationService } = require('../server/services/paymentReconciliationService');

const orderNo = '202609055487584';
const now = new Date('2026-09-14T05:00:00Z');
const approval = { merchantOrderNo: orderNo, transactionId: 'approval-1', status: '승인',
  approvedAmount: 198550, cancelAmount: 0, transactionAtIso: '2026-09-05T08:50:06Z' };
const paidOrder = { orderNo, orderStatus: 'OPEN', totalPaymentPrice: 198550, totalRefundedPrice: 0,
  payments: [{ paymentStatus: 'PAYMENT_COMPLETE', paidPrice: 198550, paymentCompleteTime: '2026-09-05T08:50:30Z' }] };
const audit = overrides => reconcilePayments({ payments: [approval], orders: [paidOrder], now,
  startDate: '2026-09-01', endDate: '2026-09-14', ...overrides });

test('Korea schedule uses 14:00 and 21:00 regardless of host timezone', () => {
  for (const [at, expected] of [
    ['2026-09-14T04:59:59Z', '2026-09-13T12:00:00.000Z'],
    ['2026-09-14T05:00:00Z', '2026-09-14T05:00:00.000Z'],
    ['2026-09-14T11:59:59Z', '2026-09-14T05:00:00.000Z'],
    ['2026-09-14T12:00:00Z', '2026-09-14T12:00:00.000Z'],
    ['2026-09-14T16:00:00Z', '2026-09-14T12:00:00.000Z'],
  ]) assert.equal(latestPaymentAuditSlot(new Date(at)), expected);
  assert.equal(paymentAuditStart(new Date('2026-10-01T05:00:00Z')), '2026-09-29');
  assert.equal(paymentAuditStart(new Date('2026-10-01T05:00:00Z'), [{ sourceDate: '2026-09-05' }]), '2026-09-05');
});

test('all-clear requires complete sources and actual confirmation', () => {
  assert.match(buildPaymentAuditMessage(audit(), now.toISOString()), /^✅/);
  for (const overrides of [{ payments: null }, { orders: null }, { payments: {} }, { orders: {} }, { errors: ['partial source'] },
    { orders: [{ ...paidOrder, totalPaymentPrice: -1 }] },
    { orders: [{ ...paidOrder, totalRefundedPrice: undefined }] },
    { payments: [{ ...approval, transactionAtIso: null }] }]) {
    const report = audit(overrides);
    assert.equal(report.complete, false);
    assert.match(buildPaymentAuditMessage(report, now.toISOString()), /^⚠️.*Incomplete/);
  }
});

test('September incident is a paid-cancelled discrepancy, not a zero-cost success', () => {
  const report = audit({ orders: [{ ...paidOrder, orderStatus: 'CLOSED', totalPaymentPrice: 0,
    payments: [{ paymentStatus: 'PAYMENT_OVERDUE', paidPrice: 198550 }] }] });
  assert.equal(report.errorCount, 1);
  assert.equal(report.issues[0].kind, 'paid_cancelled');
  assert.equal(report.issues[0].amount, 198550);
});

test('partial refund reconciles remaining Imweb balance plus refunds to gross approval', () => {
  const report = audit({ payments: [approval, { ...approval, status: '취소', transactionId: 'refund-1', approvedAmount: 0, cancelAmount: 98550 }],
    orders: [{ ...paidOrder, totalPaymentPrice: 100000, totalRefundedPrice: 98550 }] });
  assert.equal(report.issues.length, 0);
});

test('unidentified refunds, duplicate approvals and mismatches require review, never amount-only matching', () => {
  const report = audit({ payments: [approval, { ...approval, transactionId: 'approval-2' },
    { ...approval, transactionId: 'refund-1', merchantOrderNo: 'rfd_unknown', status: '취소', cancelAmount: 98550, approvedAmount: 0 }] });
  assert.ok(report.issues.some(issue => issue.kind === 'multiple_approvals'));
  assert.ok(report.issues.some(issue => issue.kind === 'amount_mismatch'));
  assert.ok(report.issues.some(issue => issue.kind === 'unidentified_reference'));
  assert.match(buildPaymentAuditMessage(report, now.toISOString()), /^⚠️/);
});

test('late confirmation is separate from a missing confirmation; expiry alone is not payment proof', () => {
  assert.equal(audit({ orders: [{ ...paidOrder, payments: [{ ...paidOrder.payments[0], paymentCompleteTime: '2026-09-06T08:50:30Z' }] }] }).issues[0].kind, 'delayed_confirmation');
  const report = audit({ payments: [], orders: [{ ...paidOrder, payments: [] }], watches: {
    [orderNo]: { orderNo, amount: 198550, status: 'expired', watchStartedAt: '2026-09-05T08:53:55Z' },
  } });
  assert.equal(report.errorCount, 0);
  assert.equal(report.issues[0].kind, 'expired_watch');
});

function fixture(overrides = {}) {
  let current = now;
  const messages = [];
  const dependencies = { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-cloud-reconciliation-')),
    enabled: true, initialCases: [], clock: () => current,
    payway: { fetchPaymentHistory: async options => { assert.equal(options.requireComplete, true); return [approval]; } },
    imweb: { getAllOrders: async options => { assert.equal(options.requireComplete, true); return [paidOrder]; } },
    watchService: { loadState: () => ({ watchedOrders: {} }) },
    telegram: { probeConnection: async () => {},
      getStatus: () => ({ status: 'connected', chatAccessible: true, chatTitle: 'Shue Updates', chatId: '-5116382321' }),
      sendMessage: async message => { messages.push(message); return { ok: true, result: { message_id: 55, chat: { id: -5116382321 } } }; },
    }, ...overrides };
  return { dependencies, messages, setTime: date => { current = new Date(date); },
    service: createPaymentReconciliationService(dependencies) };
}

test('cloud sends once per slot, coalesces concurrent calls, and preserves receipt across restart', async () => {
  const f = fixture();
  await Promise.all([f.service.runDue(), f.service.runDue()]);
  await createPaymentReconciliationService(f.dependencies).runDue();
  assert.equal(f.messages.length, 1);
  assert.equal(f.service.getStatus().messageId, 55);
  f.setTime('2026-09-14T12:00:00Z');
  await f.service.runDue();
  assert.equal(f.messages.length, 2);
});

test('missing source sends an incomplete report and preserves unresolved cases', async () => {
  const f = fixture({ initialCases: [{ orderNo, sourceDate: '2026-09-05' }],
    payway: { fetchPaymentHistory: async () => { throw new Error('offline'); } } });
  await f.service.runDue();
  assert.match(f.messages[0], /^⚠️.*Incomplete/);
  assert.equal(f.service.getStatus().unresolvedCount, 1);
});

test('unverified destination blocks sending; ambiguous delivery is not blindly repeated', async () => {
  const f = fixture();
  f.dependencies.telegram.getStatus = () => ({ status: 'connected', chatAccessible: true, chatId: 'different', chatTitle: 'Shue Updates' });
  await assert.rejects(f.service.runDue(), /destination/);
  assert.equal(f.messages.length, 0);
  const ambiguous = fixture();
  let sends = 0;
  ambiguous.dependencies.telegram.sendMessage = async () => { sends++; return null; };
  await ambiguous.service.runDue();
  await createPaymentReconciliationService(ambiguous.dependencies).runDue();
  assert.equal(sends, 1);
  assert.equal(ambiguous.service.getStatus().delivery, 'ambiguous');
});

test('corrupt state and unavailable persistent storage cannot send an untracked report', async () => {
  const f = fixture();
  const file = path.join(f.dependencies.dataDir, 'payment_reconciliation.json');
  fs.writeFileSync(file, '{bad');
  await assert.rejects(f.service.runDue());
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
  assert.equal(f.messages.length, 0);
  const fallback = fixture({ persistent: false });
  await assert.rejects(fallback.service.runDue(), /Persistent storage/);
  assert.equal(fallback.messages.length, 0);
});

test('a persisted in-flight send after crash remains uncertain and never sends twice', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.dependencies.dataDir, 'payment_reconciliation.json'), JSON.stringify({ version: 1,
    runs: { [now.toISOString()]: { status: 'sending' } }, unresolved: [] }));
  await f.service.runDue();
  assert.equal(f.messages.length, 0);
  assert.equal(f.service.getStatus().delivery, 'sending');
});

test('long reports stay within Telegram size and escape source text', () => {
  const report = audit();
  report.issues = Array.from({ length: 100 }, (_, i) => ({ orderNo: `<order&${i}>`, severity: 'review', amount: 100,
    detail: 'Unidentified payment needs review' }));
  const message = buildPaymentAuditMessage(report, now.toISOString());
  assert.ok(message.length < 4096);
  assert.match(message, /&lt;order&amp;0&gt;/);
  assert.match(message, /more items/);
});

test('an old refund expands the Payway coverage before comparing totals', async () => {
  const queries = [];
  const refund = { ...approval, status: '취소', transactionId: 'refund-old', approvedAmount: 0, cancelAmount: 198550 };
  const f = fixture({
    imweb: { getAllOrders: async () => [{ ...paidOrder, wtime: '2026-08-31T01:00:00Z', totalPaymentPrice: 0, totalRefundedPrice: 198550 }] },
    payway: { fetchPaymentHistory: async options => {
      queries.push(options.startDate); return options.startDate === '2026-08-31' ? [approval, refund] : [refund];
    } },
  });
  await f.service.runDue();
  assert.deepEqual(queries, ['2026-09-01', '2026-08-31']);
  assert.equal(f.service.getStatus().report.issues.length, 0);
});

test('an unresolved case disappearing from source history is not silently cleared', async () => {
  const f = fixture({ initialCases: [{ orderNo: '202608310000000', sourceDate: '2026-08-31' }] });
  await f.service.runDue();
  assert.equal(f.service.getStatus().report.complete, false);
  assert.equal(f.service.getStatus().unresolvedCount, 1);
  assert.match(f.messages[0], /not marked resolved/);
});

test('explicit Telegram rejection retries later; disabled service sends nothing', async () => {
  const disabled = fixture({ enabled: false });
  await disabled.service.runDue();
  assert.equal(disabled.messages.length, 0);
  const f = fixture();
  const send = f.dependencies.telegram.sendMessage;
  f.dependencies.telegram.sendMessage = async () => ({ ok: false, error_code: 429, parameters: { retry_after: 600 } });
  await f.service.runDue();
  f.dependencies.telegram.sendMessage = send;
  f.setTime('2026-09-14T05:05:00Z');
  await f.service.runDue();
  assert.equal(f.messages.length, 0);
  f.setTime('2026-09-14T05:10:00Z');
  await f.service.runDue();
  assert.equal(f.messages.length, 1);
});
