const config = require('../config');
const scheduler = require('../modules/scheduler');
const imweb = require('../modules/imwebClient');
const contracts = require('../contracts/v1');
const { KST_TIME_ZONE, formatDateInTimeZone } = require('../domain/time');
const cardSettlementClient = require('../modules/cardSettlementClient');

function createMoneySummary() {
  return {
    count: 0,
    grossApprovedAmount: 0,
    grossRefundAmount: 0,
    netAmount: 0,
  };
}

function accumulateMoneySummary(summary, amount, type) {
  summary.count += 1;
  summary.netAmount += amount;
  if (type === 'refund') {
    summary.grossRefundAmount += Math.abs(amount);
  } else {
    summary.grossApprovedAmount += amount;
  }
}

function summarizeBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeChannelGroup(method, pgName) {
  const methodLabel = String(method || '').toUpperCase();
  const pgLabel = String(pgName || '').toUpperCase();

  if (methodLabel.includes('CARD') || pgLabel.includes('CARD')) return 'card';
  if (methodLabel.includes('BANK') || pgLabel.includes('BANK')) return 'bank_transfer';
  if (methodLabel.includes('VBANK') || methodLabel.includes('VIRTUAL')) return 'virtual_account';
  if (!methodLabel && !pgLabel) return 'unknown';
  return 'other';
}

function normalizePaymentType(payment, amount) {
  if (amount < 0) return 'refund';

  const status = String(payment?.paymentStatus || '').toUpperCase();
  const cancelFlag = String(payment?.isCancel || '').toUpperCase();
  if (cancelFlag === 'Y' || status.includes('REFUND') || status.includes('CANCEL')) {
    return 'refund';
  }

  return 'approval';
}

function getPaymentTimestamp(order, payment) {
  const candidates = [
    payment?.paymentCompleteTime,
    payment?.bankTransfer?.depositCompletedTime,
    order?.mtime,
    order?.wtime,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return null;
}

function normalizeImwebPayments(orders) {
  const payments = [];

  for (const order of Array.isArray(orders) ? orders : []) {
    const paymentList = Array.isArray(order.payments) ? order.payments : [];
    for (let index = 0; index < paymentList.length; index++) {
      const payment = paymentList[index];
      const amount = Number(payment?.paidPrice || 0);
      const completedAt = getPaymentTimestamp(order, payment);
      if (!completedAt || !amount) {
        continue;
      }

      const type = normalizePaymentType(payment, amount);
      const method = String(payment?.method || '').trim();
      const pgName = String(payment?.pgName || '').trim();
      payments.push({
        paymentId: `imweb_payment:${order.orderNo}:${payment?.paymentNo || index}:${index}`,
        source: 'imweb',
        orderNo: order.orderNo ?? null,
        paymentNo: payment?.paymentNo || null,
        amount,
        type,
        completedAt: completedAt.toISOString(),
        completedDate: formatDateInTimeZone(completedAt, KST_TIME_ZONE),
        method,
        pgName,
        channelGroup: normalizeChannelGroup(method, pgName),
        paymentStatus: String(payment?.paymentStatus || '').trim(),
        isCancel: String(payment?.isCancel || '').trim(),
        payerName: String(
          payment?.bankTransfer?.depositorName ||
          order.ordererName ||
          order.memberName ||
          ''
        ).trim(),
      });
    }
  }

  return payments.sort((left, right) => {
    if (left.completedAt === right.completedAt) return left.paymentId.localeCompare(right.paymentId);
    return left.completedAt.localeCompare(right.completedAt);
  });
}

function classifyMatchConfidence(diffMs) {
  if (diffMs <= 60_000) return 'high';
  if (diffMs <= 180_000) return 'medium';
  return 'low';
}

function buildCandidateMatches(settlementTransactions, imwebPayments, windowMs) {
  const candidates = [];

  for (const settlement of settlementTransactions) {
    const settlementTime = new Date(settlement.tradedAt).getTime();
    for (const payment of imwebPayments) {
      if (settlement.amount !== payment.amount) continue;
      if (settlement.type !== payment.type) continue;

      const paymentTime = new Date(payment.completedAt).getTime();
      const diffMs = Math.abs(settlementTime - paymentTime);
      if (diffMs > windowMs) continue;

      const methodPenalty = payment.channelGroup === 'card' ? 0 : 30_000;
      candidates.push({
        settlementId: settlement.settlementId,
        paymentId: payment.paymentId,
        score: diffMs + methodPenalty,
        diffMs,
      });
    }
  }

  return candidates.sort((left, right) => left.score - right.score);
}

function matchTransactions(settlementTransactions, imwebPayments, matchWindowMinutes) {
  const windowMs = Math.max(1, matchWindowMinutes || 3) * 60 * 1000;
  const settlementById = new Map(settlementTransactions.map(item => [item.settlementId, item]));
  const paymentById = new Map(imwebPayments.map(item => [item.paymentId, item]));
  const usedSettlements = new Set();
  const usedPayments = new Set();
  const matches = [];

  const candidates = buildCandidateMatches(settlementTransactions, imwebPayments, windowMs);
  for (const candidate of candidates) {
    if (usedSettlements.has(candidate.settlementId) || usedPayments.has(candidate.paymentId)) {
      continue;
    }

    const settlement = settlementById.get(candidate.settlementId);
    const payment = paymentById.get(candidate.paymentId);
    if (!settlement || !payment) continue;

    usedSettlements.add(settlement.settlementId);
    usedPayments.add(payment.paymentId);

    matches.push({
      matchId: `recon_match:${settlement.settlementId}:${payment.paymentId}`,
      confidence: classifyMatchConfidence(candidate.diffMs),
      timeDeltaSeconds: Math.round(candidate.diffMs / 1000),
      methodMismatch: payment.channelGroup !== 'card',
      amount: settlement.amount,
      type: settlement.type,
      settlement,
      imwebPayment: payment,
    });
  }

  const unmatchedSettlements = settlementTransactions.filter(item => !usedSettlements.has(item.settlementId));
  const unmatchedPayments = imwebPayments.filter(item => !usedPayments.has(item.paymentId));

  return {
    matches,
    unmatchedSettlements,
    unmatchedPayments,
  };
}

function buildDailySummary(settlementTransactions, imwebPayments, matches, unmatchedSettlements, unmatchedPayments) {
  const daily = new Map();

  function ensureDay(date) {
    if (!daily.has(date)) {
      daily.set(date, {
        date,
        settlement: createMoneySummary(),
        imweb: createMoneySummary(),
        matched: createMoneySummary(),
        unmatchedSettlement: createMoneySummary(),
        unmatchedImweb: createMoneySummary(),
      });
    }
    return daily.get(date);
  }

  for (const settlement of settlementTransactions) {
    accumulateMoneySummary(ensureDay(settlement.tradedDate).settlement, settlement.amount, settlement.type);
  }

  for (const payment of imwebPayments) {
    accumulateMoneySummary(ensureDay(payment.completedDate).imweb, payment.amount, payment.type);
  }

  for (const match of matches) {
    accumulateMoneySummary(ensureDay(match.settlement.tradedDate).matched, match.amount, match.type);
  }

  for (const settlement of unmatchedSettlements) {
    accumulateMoneySummary(ensureDay(settlement.tradedDate).unmatchedSettlement, settlement.amount, settlement.type);
  }

  for (const payment of unmatchedPayments) {
    accumulateMoneySummary(ensureDay(payment.completedDate).unmatchedImweb, payment.amount, payment.type);
  }

  return Array.from(daily.values()).sort((left, right) => left.date.localeCompare(right.date));
}

function buildSummary(settlementReport, imwebPayments, matchResult) {
  const settlementSummary = {
    configured: settlementReport.configured,
    spreadsheetId: settlementReport.spreadsheetId,
    gid: settlementReport.gid,
    merchantName: settlementReport.merchantName,
    fetchedAt: settlementReport.fetchedAt,
    ...settlementReport.totals,
  };

  const imwebTotals = createMoneySummary();
  for (const payment of imwebPayments) {
    accumulateMoneySummary(imwebTotals, payment.amount, payment.type);
  }

  const matchTotals = createMoneySummary();
  let methodMismatchCount = 0;
  let methodMismatchAmount = 0;
  for (const match of matchResult.matches) {
    accumulateMoneySummary(matchTotals, match.amount, match.type);
    if (match.methodMismatch) {
      methodMismatchCount += 1;
      methodMismatchAmount += match.amount;
    }
  }

  return {
    settlement: settlementSummary,
    imweb: {
      paymentCount: imwebPayments.length,
      ...imwebTotals,
      byChannelGroup: summarizeBy(imwebPayments, payment => payment.channelGroup),
      byMethod: summarizeBy(imwebPayments, payment => `${payment.method || 'UNKNOWN'}/${payment.pgName || 'UNKNOWN'}`),
    },
    overlap: {
      matchedCount: matchResult.matches.length,
      matchedPaymentCount: matchResult.matches.length,
      ...matchTotals,
      methodMismatchCount,
      methodMismatchAmount,
      confidence: summarizeBy(matchResult.matches, match => match.confidence),
      unmatchedSettlementCount: matchResult.unmatchedSettlements.length,
      unmatchedImwebCount: matchResult.unmatchedPayments.length,
    },
  };
}

async function getOrdersForReconciliation(options = {}) {
  if (options.refresh) {
    return imweb.getAllOrders();
  }

  const latestOrders = scheduler.getLatestData().orders || [];
  if (latestOrders.length > 0) {
    return latestOrders;
  }

  return imweb.getAllOrders();
}

async function getReconciliationResponse(options = {}) {
  const settlementReport = await cardSettlementClient.fetchCardSettlementReport();
  const orders = await getOrdersForReconciliation(options);
  const imwebPayments = normalizeImwebPayments(orders);
  const matchWindowMinutes = config.cardSettlement.matchWindowMinutes;
  const matchResult = settlementReport.configured
    ? matchTransactions(settlementReport.transactions, imwebPayments, matchWindowMinutes)
    : { matches: [], unmatchedSettlements: [], unmatchedPayments: imwebPayments };

  const summary = buildSummary(settlementReport, imwebPayments, matchResult);
  const daily = buildDailySummary(
    settlementReport.transactions,
    imwebPayments,
    matchResult.matches,
    matchResult.unmatchedSettlements,
    matchResult.unmatchedPayments
  );

  return contracts.reconciliation({
    ready: settlementReport.configured,
    matchWindowMinutes,
    summary,
    daily,
    matches: matchResult.matches,
    unmatchedSettlements: matchResult.unmatchedSettlements,
    unmatchedImwebPayments: matchResult.unmatchedPayments,
  });
}

module.exports = {
  getReconciliationResponse,
  normalizeImwebPayments,
  matchTransactions,
};
