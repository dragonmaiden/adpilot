const fs = require('fs');
const path = require('path');
const { formatDateInTimeZone, KST_TIME_ZONE } = require('../domain/time');
const { latestPaymentAuditSlot, paymentAuditStart, reconcilePayments, buildPaymentAuditMessage } = require('../domain/paymentReconciliation');

const EXPECTED_CHAT_ID = '-5116382321';
const EXPECTED_CHAT_TITLE = 'Shue Updates';
const SEED_CASES = [
  { orderNo: '202609055487584', sourceDate: '2026-09-05' },
  { orderNo: 'A_1789025866_Mzc2MDI', sourceDate: '2026-09-10' },
  { orderNo: 'A_1788506325_MzcyMzk', sourceDate: '2026-09-04' },
];

function createPaymentReconciliationService({ dataDir, enabled, imweb, payway, telegram, watchService,
  persistent = true, initialCases = SEED_CASES, clock = () => new Date() }) {
  const stateFile = path.join(dataDir, 'payment_reconciliation.json');
  let running = null;
  let timer = null;
  let lastError = null;
  function load() {
    if (!fs.existsSync(stateFile)) return { version: 1, runs: {}, unresolved: initialCases };
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.version !== 1 || !state.runs || typeof state.runs !== 'object' || Array.isArray(state.runs)
      || !Array.isArray(state.unresolved)) throw new Error('Invalid reconciliation state; refusing to reset history');
    return state;
  }
  function save(state) {
    if (!persistent) throw new Error('Persistent storage unavailable; refusing untracked Telegram delivery');
    const temp = `${stateFile}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, stateFile);
  }
  function getStatus() {
    try {
      const state = load();
      const latest = Object.keys(state.runs).sort().at(-1);
      const run = state.runs[latest];
      return { enabled, schedule: '14:00 and 21:00 Asia/Seoul', running: Boolean(running),
        lastError, latestSlot: latest || null, delivery: run?.status || null,
        messageId: run?.messageId || null, report: run?.report || null,
        unresolvedCount: state.unresolved.length };
    } catch (err) { return { enabled, lastError: err.message, delivery: 'state_error' }; }
  }
  async function perform(slot) {
    const state = load();
    const prior = state.runs[slot];
    // A crash/timeout after send may have delivered. Never blindly resend it.
    if (prior && ['sent', 'sending', 'ambiguous'].includes(prior.status)) return getStatus();
    if (prior?.retryAfter && Date.parse(prior.retryAfter) > clock().getTime()) return getStatus();
    const now = clock();
    let startDate = paymentAuditStart(now, state.unresolved);
    const endDate = formatDateInTimeZone(now, KST_TIME_ZONE);
    const errors = [];
    let payments = null;
    let orders = null;
    let watches = {};
    // Use the existing in-process token owner. No independent credentials or scan side effects.
    await Promise.all([
      payway.fetchPaymentHistory({ startDate, endDate, now, requireComplete: true })
        .then(result => { payments = result; }).catch(() => errors.push('Payway fetch failed; approval/refund coverage unavailable')),
      imweb.getAllOrders({ endTime: now, requireComplete: true, timeoutMs: 10000 })
        .then(result => { orders = result; }).catch(() => errors.push('Imweb fetch failed; order/payment coverage unavailable')),
    ]);
    // A current-month refund may refer to an older order. Include its original
    // order period before comparing approval and refund totals.
    if (Array.isArray(payments) && Array.isArray(orders)) {
      const referenced = new Set(payments.map(payment => payment.merchantOrderNo));
      const earlier = orders.filter(order => referenced.has(order.orderNo) && Number.isFinite(Date.parse(order.wtime)))
        .map(order => formatDateInTimeZone(new Date(order.wtime), KST_TIME_ZONE)).sort()[0];
      if (earlier && earlier < startDate) {
        startDate = earlier;
        try { payments = await payway.fetchPaymentHistory({ startDate, endDate, now, requireComplete: true }); }
        catch (_) { payments = null; errors.push('Extended Payway history unavailable for older referenced orders'); }
      }
      for (const issue of state.unresolved) {
        if (payments && !payments.some(payment => payment.merchantOrderNo === issue.orderNo)) {
          errors.push(`Earlier unresolved reference ${issue.orderNo} is absent from source history; not marked resolved`);
        }
      }
    }
    try { watches = watchService.loadState().watchedOrders; }
    catch (_) { errors.push('Payment-watch history unavailable'); }
    const report = reconcilePayments({ payments, orders, watches, startDate, endDate, now: clock(), errors });
    // Completed historical delays stay in this report, but are not unpaid cases
    // to carry forward indefinitely beyond the month being audited.
    if (report.complete) state.unresolved = report.issues.filter(issue => issue.kind !== 'delayed_confirmation');
    else state.unresolved = [...state.unresolved, ...report.issues]
      .filter((issue, index, all) => all.findIndex(other => other.orderNo === issue.orderNo && other.kind === issue.kind) === index);
    const previousUncertain = Object.entries(state.runs).filter(([key, run]) => key !== slot
      && ['sending', 'ambiguous', 'failed'].includes(run.status));
    if (previousUncertain.length) {
      report.complete = false;
      report.errors.push(`${previousUncertain.length} earlier scheduled report(s) have unverified Telegram delivery`);
    }
    const run = { slot, status: 'prepared', report, attempts: Number(prior?.attempts || 0), preparedAt: clock().toISOString() };
    state.runs[slot] = run;
    // Keep recent delivery receipts and every unresolved/ambiguous delivery.
    for (const key of Object.keys(state.runs).sort().slice(0, -62)) {
      if (state.runs[key].status === 'sent') delete state.runs[key];
    }
    save(state);
    await telegram.probeConnection();
    const destination = telegram.getStatus();
    if (destination.status !== 'connected' || !destination.chatAccessible
      || String(destination.chatId) !== EXPECTED_CHAT_ID || destination.chatTitle !== EXPECTED_CHAT_TITLE) {
      run.status = 'failed'; run.reason = 'Telegram destination could not be verified';
      run.retryAfter = new Date(clock().getTime() + 5 * 60000).toISOString();
      save(state); throw new Error(run.reason);
    }
    run.status = 'sending'; run.attempts++; run.sendStartedAt = clock().toISOString();
    save(state);
    let response;
    try { response = await telegram.sendMessage(buildPaymentAuditMessage(report, slot), 'HTML'); }
    catch (_) { response = null; }
    if (response?.ok === true && Number.isInteger(response.result?.message_id)
      && String(response.result?.chat?.id) === EXPECTED_CHAT_ID) {
      run.status = 'sent'; run.messageId = response.result.message_id; run.sentAt = clock().toISOString();
      lastError = null;
      console.log(`[PAYMENT AUDIT] Report delivered slot=${slot} message_id=${run.messageId} complete=${report.complete} errors=${report.errorCount} review=${report.reviewCount}`);
    } else if (response?.ok === false && [400, 401, 403, 429].includes(response.error_code)) {
      run.status = 'failed'; run.reason = 'Telegram explicitly rejected report';
      run.retryAfter = new Date(clock().getTime() + Math.max(300, Number(response.parameters?.retry_after || 0)) * 1000).toISOString();
      lastError = run.reason;
    } else {
      run.status = 'ambiguous'; run.reason = 'Telegram delivery unverified; manual review required before resend';
      lastError = run.reason;
    }
    save(state);
    return getStatus();
  }
  function runDue() {
    if (!enabled) return Promise.resolve({ enabled: false });
    if (running) return running;
    const slot = latestPaymentAuditSlot(clock());
    running = perform(slot).catch(err => { lastError = err.message; console.error(`[PAYMENT AUDIT] ${err.message}`); throw err; })
      .finally(() => { running = null; });
    return running;
  }
  function start() {
    if (!enabled || timer) return;
    console.log('[PAYMENT AUDIT] Cloud schedule enabled: 14:00 and 21:00 Asia/Seoul');
    const tick = () => { runDue().catch(() => {}); };
    timer = setInterval(tick, 60000); timer.unref(); tick();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, runDue, getStatus };
}

let instance;
function getService() {
  if (!instance) {
    const config = require('../config');
    const paths = require('../runtime/paths');
    instance = createPaymentReconciliationService({
      dataDir: paths.dataDir, persistent: !paths.usedFallback, enabled: config.paymentReconciliation.enabled,
      imweb: require('../modules/imwebClient'), payway: require('../modules/paywayClient'),
      telegram: require('../modules/telegram'), watchService: require('./paywayPaymentWatchService'),
    });
  }
  return instance;
}
module.exports = { createPaymentReconciliationService, getService };
