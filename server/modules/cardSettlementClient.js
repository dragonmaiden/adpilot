const config = require('../config');
const { KST_TIME_ZONE, formatDateInTimeZone } = require('../domain/time');
const { parseCSV, parseKRW } = require('./cogsClient');

const HEADER_MAP = {
  tradedAt: '거래일자',
  transactionKind: '결제',
  merchantName: '가맹점명',
  terminalId: '터미널',
  acquirer: '매입사',
  installmentMonths: '할부',
  maskedCardNumber: '카드번호',
  approvalNumber: '승인번호',
  approvedAmount: '승인금액',
  cancelledAmount: '취소금액',
  transactionAmount: '거래금액',
  feeAmount: '수수료',
  settlementAmount: '정산금액',
  settlementDueDate: '정산예정',
  pgName: 'PG',
  agentName: 'AGENT',
  cancelReference: '취소일자(원거래일자)',
};

function getSettings() {
  return config.cardSettlement || {};
}

function isConfigured() {
  return Boolean(getSettings().spreadsheetId);
}

function parseKstDateTime(value) {
  const input = String(value || '').trim();
  if (!input) return null;

  const match = input.match(
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) return null;

  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}+09:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeSheetDate(value) {
  const input = String(value || '').trim();
  if (!input) return '';

  const compact = input.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }

  const date = parseKstDateTime(input);
  return date ? formatDateInTimeZone(date, KST_TIME_ZONE) : '';
}

function getHeaderIndexes(headerRow) {
  const indexes = {};
  for (const [key, headerName] of Object.entries(HEADER_MAP)) {
    indexes[key] = headerRow.indexOf(headerName);
  }
  return indexes;
}

function requireHeaders(indexes) {
  const missing = Object.entries(indexes)
    .filter(([, index]) => index < 0)
    .map(([key]) => HEADER_MAP[key]);

  if (missing.length > 0) {
    throw new Error(`Card settlement sheet is missing required columns: ${missing.join(', ')}`);
  }
}

function classifyTransactionType(kind, amount) {
  const normalizedKind = String(kind || '').trim();
  if (normalizedKind.includes('취소') || amount < 0) return 'refund';
  if (normalizedKind.includes('승인')) return 'approval';
  return amount < 0 ? 'refund' : 'approval';
}

function createTotals() {
  return {
    transactionCount: 0,
    approvalCount: 0,
    refundCount: 0,
    grossApprovedAmount: 0,
    grossRefundAmount: 0,
    netTransactionAmount: 0,
    totalFees: 0,
    totalSettlementAmount: 0,
  };
}

function accumulateTotals(totals, amount, type, feeAmount, settlementAmount) {
  totals.transactionCount += 1;
  totals.netTransactionAmount += amount;
  totals.totalFees += feeAmount;
  totals.totalSettlementAmount += settlementAmount;

  if (type === 'refund') {
    totals.refundCount += 1;
    totals.grossRefundAmount += Math.abs(amount);
  } else {
    totals.approvalCount += 1;
    totals.grossApprovedAmount += amount;
  }
}

function parseTransactions(rows, { spreadsheetId, gid }) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return [];
  }

  const [headerRow, ...bodyRows] = rows;
  const indexes = getHeaderIndexes(headerRow);
  requireHeaders(indexes);

  const transactions = [];
  for (let rowIndex = 0; rowIndex < bodyRows.length; rowIndex++) {
    const row = bodyRows[rowIndex];
    if (!row || row.every(cell => !String(cell || '').trim())) {
      continue;
    }

    const tradedAt = parseKstDateTime(row[indexes.tradedAt]);
    const amount = parseKRW(row[indexes.transactionAmount]);
    if (!tradedAt || !amount) {
      continue;
    }

    const rowNumber = rowIndex + 2;
    const type = classifyTransactionType(row[indexes.transactionKind], amount);
    const feeAmount = parseKRW(row[indexes.feeAmount]);
    const settlementAmount = parseKRW(row[indexes.settlementAmount]);

    transactions.push({
      settlementId: `card_settlement:${spreadsheetId}:${gid}:${rowNumber}`,
      source: 'card_settlement_sheet',
      rowNumber,
      tradedAt: tradedAt.toISOString(),
      tradedDate: formatDateInTimeZone(tradedAt, KST_TIME_ZONE),
      type,
      transactionKind: String(row[indexes.transactionKind] || '').trim(),
      merchantName: String(row[indexes.merchantName] || '').trim(),
      terminalId: String(row[indexes.terminalId] || '').trim(),
      acquirer: String(row[indexes.acquirer] || '').trim(),
      installmentMonths: Number.parseInt(String(row[indexes.installmentMonths] || '0'), 10) || 0,
      maskedCardNumber: String(row[indexes.maskedCardNumber] || '').trim(),
      approvalNumber: String(row[indexes.approvalNumber] || '').trim(),
      approvedAmount: parseKRW(row[indexes.approvedAmount]),
      cancelledAmount: parseKRW(row[indexes.cancelledAmount]),
      amount,
      feeAmount,
      settlementAmount,
      settlementDueDate: normalizeSheetDate(row[indexes.settlementDueDate]),
      pgName: String(row[indexes.pgName] || '').trim(),
      agentName: String(row[indexes.agentName] || '').trim(),
      cancelReference: String(row[indexes.cancelReference] || '').trim(),
    });
  }

  return transactions;
}

function aggregateTransactions(transactions) {
  const totals = createTotals();
  const byDate = new Map();

  for (const transaction of transactions) {
    accumulateTotals(
      totals,
      transaction.amount,
      transaction.type,
      transaction.feeAmount,
      transaction.settlementAmount
    );

    const day = byDate.get(transaction.tradedDate) || createTotals();
    accumulateTotals(
      day,
      transaction.amount,
      transaction.type,
      transaction.feeAmount,
      transaction.settlementAmount
    );
    byDate.set(transaction.tradedDate, day);
  }

  return {
    totals,
    daily: Array.from(byDate.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, values]) => ({ date, ...values })),
  };
}

async function fetchCardSettlementReport(options = {}) {
  const settings = {
    ...getSettings(),
    ...options,
  };

  if (!settings.spreadsheetId) {
    return {
      configured: false,
      fetchedAt: new Date().toISOString(),
      spreadsheetId: '',
      gid: settings.gid || '0',
      merchantName: settings.merchantName || '',
      transactions: [],
      totals: createTotals(),
      daily: [],
    };
  }

  const gid = String(settings.gid || '0');
  const url = `https://docs.google.com/spreadsheets/d/${settings.spreadsheetId}/export?format=csv&gid=${gid}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Card settlement sheet fetch failed (gid=${gid}): HTTP ${response.status}`);
  }

  const rows = parseCSV(await response.text());
  const transactions = parseTransactions(rows, {
    spreadsheetId: settings.spreadsheetId,
    gid,
  });
  const aggregate = aggregateTransactions(transactions);

  return {
    configured: true,
    fetchedAt: new Date().toISOString(),
    spreadsheetId: settings.spreadsheetId,
    gid,
    merchantName: settings.merchantName || '',
    transactions,
    totals: aggregate.totals,
    daily: aggregate.daily,
  };
}

module.exports = {
  fetchCardSettlementReport,
  parseKstDateTime,
  normalizeSheetDate,
  parseTransactions,
  aggregateTransactions,
  isConfigured,
};
