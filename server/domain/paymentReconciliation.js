const { formatDateInTimeZone, KST_TIME_ZONE } = require('./time');
const { getOrderCashTotals, isTerminalImwebOrder } = require('./imwebPayments');

const HOUR = 3600000;
const text = value => String(value ?? '').trim();
const money = value => value !== null && value !== undefined && value !== ''
  && Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
const exactReference = value => /^\d{12,20}$/.test(text(value));

function latestPaymentAuditSlot(now = new Date()) {
  const day = formatDateInTimeZone(now, KST_TIME_ZONE);
  const slots = [new Date(`${day}T14:00:00+09:00`), new Date(`${day}T21:00:00+09:00`)];
  return (slots.filter(date => date <= now).at(-1)
    || new Date(slots[1].getTime() - 24 * HOUR)).toISOString();
}

function paymentAuditStart(now, unresolved = []) {
  const day = formatDateInTimeZone(now, KST_TIME_ZONE);
  return [day.slice(0, 8) + '01', formatDateInTimeZone(new Date(now.getTime() - 48 * HOUR), KST_TIME_ZONE),
    ...unresolved.map(issue => issue.sourceDate).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date || ''))]
    .sort()[0];
}

function reconcilePayments({ payments, orders, watches = {}, startDate, endDate, now = new Date(), errors = [] }) {
  const issues = [];
  const incomplete = [...errors];
  const add = (orderNo, kind, severity, amount, sourceDate, detail) => {
    const id = `${orderNo}:${kind}`;
    if (!issues.some(issue => issue.id === id)) issues.push({ id, orderNo, kind, severity, amount, sourceDate, detail });
  };
  if (!Array.isArray(payments)) incomplete.push('Payway records unavailable');
  if (!Array.isArray(orders)) incomplete.push('Imweb records unavailable');
  const sourceOrders = Array.isArray(orders) ? orders : [];
  const sourcePayments = Array.isArray(payments) ? payments : [];
  const byOrder = new Map(sourceOrders.map(order => [text(order.orderNo), order]));
  const groups = new Map();
  const seen = new Set();
  for (const payment of sourcePayments) {
    if (!payment.transactionId || !payment.transactionAtIso || !Number.isFinite(Date.parse(payment.transactionAtIso))) {
      incomplete.push('Payway transaction has missing identity or timestamp'); continue;
    }
    // The source client already deduplicates overlapping terminal queries.
    if (seen.has(payment.transactionId)) continue;
    seen.add(payment.transactionId);
    if (Date.parse(payment.transactionAtIso) > now.getTime()) continue;
    const orderNo = text(payment.merchantOrderNo);
    const date = formatDateInTimeZone(new Date(payment.transactionAtIso), KST_TIME_ZONE);
    const amount = payment.status === '취소' ? money(payment.cancelAmount) : money(payment.approvedAmount);
    if (!['승인', '취소'].includes(payment.status) || amount === null || amount <= 0) {
      incomplete.push('Payway transaction has unsupported status or amount'); continue;
    }
    if (!exactReference(orderNo)) {
      add(orderNo || payment.transactionId, 'unidentified_reference', 'review', amount, date,
        `${payment.status === '취소' ? 'Refund' : 'Approval'} has no exact Imweb order reference`);
      continue;
    }
    const group = groups.get(orderNo) || { approvals: [], refunds: [], date };
    group[payment.status === '취소' ? 'refunds' : 'approvals'].push(payment);
    if (date < group.date) group.date = date;
    groups.set(orderNo, group);
  }
  let confirmedOrders = 0;
  for (const [orderNo, group] of groups) {
    if (!Array.isArray(orders)) continue;
    const order = byOrder.get(orderNo);
    const approved = group.approvals.reduce((sum, payment) => sum + money(payment.approvedAmount), 0);
    const refunded = group.refunds.reduce((sum, payment) => sum + money(payment.cancelAmount), 0);
    if (!order) {
      add(orderNo, 'missing_order', 'review', approved || refunded, group.date, 'Payway transaction has no Imweb order in the complete source response');
      continue;
    }
    if (group.approvals.length > 1) add(orderNo, 'multiple_approvals', 'review', approved, group.date,
      'Multiple approvals; check for duplicate charge or legitimate split payment');
    const completed = (order.payments || []).filter(payment =>
      payment.paymentStatus === 'PAYMENT_COMPLETE' && money(payment.paidPrice) > 0
      && Number.isFinite(Date.parse(payment.paymentCompleteTime || payment.bankTransfer?.depositCompletedTime)));
    const cash = getOrderCashTotals(order);
    if (money(order.totalPaymentPrice) === null || money(order.totalRefundedPrice) === null
      || money(order.totalPaymentPrice) < 0 || money(order.totalRefundedPrice) < 0) {
      incomplete.push(`Imweb cash totals missing for ${orderNo}`); continue;
    }
    const hasCashHistory = completed.length > 0 || cash.refundedAmount > 0;
    if (approved > refunded && !hasCashHistory) {
      add(orderNo, isTerminalImwebOrder(order) ? 'paid_cancelled' : 'unconfirmed', 'error', approved - refunded, group.date,
        isTerminalImwebOrder(order) ? 'Payway paid; Imweb cancelled/closed without confirmation' : 'Payway paid; Imweb confirmation missing');
    } else if (approved && hasCashHistory) {
      confirmedOrders++;
      if (cash.approvedAmount !== approved) add(orderNo, 'amount_mismatch', 'review', approved, group.date,
        `Payway approvals ${approved}; Imweb gross paid ${cash.approvedAmount} (check split payments)`);
    }
    if (refunded !== cash.refundedAmount) add(orderNo, 'refund_mismatch', 'review', refunded, group.date,
      `Payway exact-reference refunds ${refunded}; Imweb refunds ${cash.refundedAmount}; unlinked refunds require review`);
    if (!approved && refunded) add(orderNo, 'approval_outside_coverage', 'review', refunded, group.date,
      'Refund found without its original approval in the checked period');
    if (completed.length && group.approvals.length === 1) {
      const confirmedAt = Math.min(...completed.map(payment => Date.parse(payment.paymentCompleteTime || payment.bankTransfer.depositCompletedTime)));
      const delay = confirmedAt - Date.parse(group.approvals[0].transactionAtIso);
      if (delay > 60000) add(orderNo, 'delayed_confirmation', 'review', approved, group.date,
        `Confirmed, but ${Math.ceil(delay / 60000)} minutes after Payway approval; check provider visibility and processing delay`);
    }
  }
  for (const watch of Object.values(watches)) {
    const orderNo = text(watch.orderNo);
    const order = byOrder.get(orderNo);
    if (!order || !Array.isArray(payments)) continue;
    const hasConfirmation = (order.payments || []).some(payment => payment.paymentStatus === 'PAYMENT_COMPLETE'
      && Number.isFinite(Date.parse(payment.paymentCompleteTime || payment.bankTransfer?.depositCompletedTime)));
    if (hasConfirmation) continue;
    const date = text(watch.watchStartedAt).slice(0, 10);
    if (watch.matchedPayment && ['payment_detected', 'completion_failed'].includes(watch.status)) {
      add(orderNo, 'failed_confirmation', 'error', money(watch.amount), date, 'Detected payment still has no verified Imweb confirmation');
    } else if (watch.status === 'expired' && !isTerminalImwebOrder(order) && date >= startDate) {
      add(orderNo, 'expired_watch', 'review', money(watch.amount), date, 'Watch expired; this alone does not prove the customer paid');
    }
  }
  return { generatedAt: now.toISOString(), startDate, endDate, complete: incomplete.length === 0,
    errors: [...new Set(incomplete)], paymentRows: sourcePayments.length, checkedOrders: groups.size,
    confirmedOrders, issues, errorCount: issues.filter(issue => issue.severity === 'error').length,
    reviewCount: issues.filter(issue => issue.severity === 'review').length };
}

function buildPaymentAuditMessage(report, slot) {
  const escape = value => text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Telegram is a missed-confirmation alert, not the detailed accounting audit.
  // Count affected orders once even if both the watch and source check flag them.
  const failures = [...new Map(report.issues.filter(issue => issue.severity === 'error'
    && ['paid_cancelled', 'unconfirmed', 'failed_confirmation'].includes(issue.kind))
    .map(issue => [issue.orderNo, issue])).values()];
  const uncertain = report.issues.filter(issue => issue.kind === 'missing_order'
    || (issue.kind === 'unidentified_reference' && issue.detail.startsWith('Approval')));
  const clear = report.complete && failures.length === 0 && uncertain.length === 0;
  const title = failures.length ? 'Action needed' : !report.complete ? 'Incomplete'
    : uncertain.length ? 'No confirmed failures' : 'No missed confirmations found';
  const icon = failures.length || !report.complete ? '⚠️' : clear ? '✅' : 'ℹ️';
  const kst = date => new Date(date).toLocaleString('en-GB', { timeZone: KST_TIME_ZONE, hour12: false });
  const lines = [`${icon} <b>Payment confirmation check — ${title}</b>`,
    `Scheduled: ${kst(slot)} KST`, `Checked: ${kst(report.generatedAt)} KST`,
    `Coverage: ${report.startDate} to ${report.endDate} · Payway ↔ Imweb`,
    `${report.complete ? 'COMPLETE' : 'INCOMPLETE'} · ${report.paymentRows} transactions · ${report.checkedOrders} order references`,
    `<b>Paid orders missing Imweb confirmation: ${failures.length}</b>`];
  if (clear) lines.push('No missing confirmations found among matched Payway orders.');
  if (uncertain.length) lines.push(`Unverified: ${uncertain.length} payment references could not be matched to an Imweb order. These are not confirmed failures; details retained in the saved report.`);
  for (const error of report.errors.slice(0, 5)) lines.push(`⚠️ ${escape(error).slice(0, 240)}`);
  if (report.errors.length > 5) lines.push(`${report.errors.length - 5} more source limitations in the saved report.`);
  let displayed = 0;
  for (const issue of failures) {
    const line = `\n⚠️ ${escape(issue.orderNo)}${issue.amount == null ? '' : ` · ₩${issue.amount.toLocaleString('en-US')}`}\n${escape(issue.detail)}`;
    if (displayed >= 10 || lines.join('\n').length + line.length > 3300) break;
    lines.push(line); displayed++;
  }
  if (displayed < failures.length) lines.push(`\n${failures.length - displayed} more affected orders in AdPilot's saved reconciliation report.`);
  if (failures.length) lines.push('\nCheck Payway and Imweb before restoring a cancelled order or charging again.');
  lines.push('Scope: missing payment confirmations, not a full refund/accounting audit.');
  lines.push('Read-only check. No orders or payments changed.');
  return lines.join('\n');
}

module.exports = { latestPaymentAuditSlot, paymentAuditStart, reconcilePayments, buildPaymentAuditMessage };
