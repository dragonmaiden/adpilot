// ═══════════════════════════════════════════════════════
// AdPilot — COGS Client (Google Sheets Integration)
// Reads cost, purchase, and refund markers from the public
// Google Sheet. Red text in the workbook is treated as a
// refund marker, with note keywords as a fallback.
// ═══════════════════════════════════════════════════════

const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const config = require('../config');

const SPREADSHEET_ID = config.cogs.spreadsheetId;
const SHEET_GIDS = config.cogs.sheetGids;
const PRIMARY_REFUND_COLUMNS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
const REFUND_NOTE_KEYWORDS = ['취소', '환불', '반환'];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

/**
 * Fetch a single sheet tab as CSV and parse into rows.
 * Uses the public /export?format=csv endpoint (no auth needed for public sheets).
 */
async function fetchSheetCSV(gid) {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${gid}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Sheets CSV export failed (gid=${gid}): HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseCSV(text);
}

async function fetchWorkbookZip() {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=xlsx`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Sheets XLSX export failed: HTTP ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return new AdmZip(buffer);
}

function parseWorkbookSheets(zip) {
  const workbook = xmlParser.parse(zip.readAsText('xl/workbook.xml'));
  const rels = xmlParser.parse(zip.readAsText('xl/_rels/workbook.xml.rels'));

  const relMap = new Map(
    asArray(rels.Relationships?.Relationship).map(rel => [rel.Id, rel.Target])
  );

  return asArray(workbook.workbook?.sheets?.sheet).map(sheet => {
    const target = relMap.get(sheet['r:id']);
    return {
      name: sheet.name || '',
      path: target ? `xl/${target}` : null,
    };
  }).filter(sheet => sheet.path);
}

function parseWorkbookStyles(zip) {
  const styles = xmlParser.parse(zip.readAsText('xl/styles.xml')).styleSheet || {};

  const fonts = asArray(styles.fonts?.font).map(font => {
    const rgb = String(font?.color?.rgb || '').toUpperCase();
    return {
      isRed: rgb.endsWith('FF0000'),
      isStruck: font?.strike !== undefined,
    };
  });

  const cellFormats = asArray(styles.cellXfs?.xf).map(format => ({
    fontId: Number.parseInt(format.fontId || '0', 10) || 0,
  }));

  return { fonts, cellFormats };
}

function getColumnFromCellRef(ref) {
  return String(ref || '').replace(/[0-9]/g, '');
}

function hasRefundStyle(cell, styles) {
  const styleIndex = Number.parseInt(cell?.s || '0', 10) || 0;
  const fontId = styles.cellFormats[styleIndex]?.fontId || 0;
  const font = styles.fonts[fontId] || {};
  return !!(font.isRed || font.isStruck);
}

function readWorksheetRefundRows(zip, sheetPath, styles) {
  const worksheet = xmlParser.parse(zip.readAsText(sheetPath)).worksheet || {};
  const rows = asArray(worksheet.sheetData?.row);
  const refundRows = new Set();

  for (const row of rows) {
    const rowNumber = Number.parseInt(row.r || '0', 10);
    if (!rowNumber) continue;

    const cells = asArray(row.c);
    const hasRefundMarker = cells.some(cell => {
      const column = getColumnFromCellRef(cell.r);
      const value = cell.v == null ? '' : String(cell.v).trim();
      return PRIMARY_REFUND_COLUMNS.has(column) && value !== '' && hasRefundStyle(cell, styles);
    });

    if (hasRefundMarker) {
      refundRows.add(rowNumber);
    }
  }

  return refundRows;
}

async function fetchWorkbookRefundMarkers() {
  const zip = await fetchWorkbookZip();
  const workbookSheets = parseWorkbookSheets(zip);
  const styles = parseWorkbookStyles(zip);
  const markerMap = {};
  const sheetEntries = Object.entries(SHEET_GIDS);

  sheetEntries.forEach(([label], index) => {
    const sheet = workbookSheets.find(entry => entry.name.includes(label)) || workbookSheets[index];
    if (!sheet) return;
    markerMap[label] = readWorksheetRefundRows(zip, sheet.path, styles);
  });

  return markerMap;
}

/**
 * RFC 4180-compliant CSV parser.
 * Single-pass: handles quoted fields with embedded commas, newlines, and escaped quotes.
 */
function parseCSV(text) {
  const rows = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const row = [];
    while (i < len) {
      if (text[i] === '"') {
        i++;
        let field = '';
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field.trim());
        if (i < len && text[i] === ',') {
          i++;
        } else {
          if (i < len && text[i] === '\r') i++;
          if (i < len && text[i] === '\n') i++;
          break;
        }
      } else if (text[i] === '\r' || text[i] === '\n') {
        row.push('');
        if (text[i] === '\r') i++;
        if (i < len && text[i] === '\n') i++;
        break;
      } else {
        let field = '';
        while (i < len && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
          field += text[i];
          i++;
        }
        row.push(field.trim());
        if (i < len && text[i] === ',') {
          i++;
        } else {
          if (i < len && text[i] === '\r') i++;
          if (i < len && text[i] === '\n') i++;
          break;
        }
      }
    }

    if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
      rows.push(row);
    }
  }

  return rows;
}

/**
 * Parse a Korean Won string like "₩45,000" into a number.
 */
function parseKRW(str) {
  if (!str || typeof str !== 'string') return 0;
  const cleaned = str.replace(/[₩,\s]/g, '');
  const num = Number.parseInt(cleaned, 10);
  return Number.isNaN(num) ? 0 : num;
}

function normalizeSheetDate(value) {
  const input = String(value || '').trim();
  if (!input) return '';

  const isoMatch = input.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const usMatch = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return input;
}

function hasRefundNoteKeyword(note) {
  const text = String(note || '').trim();
  return REFUND_NOTE_KEYWORDS.some(keyword => text.includes(keyword));
}

/**
 * Parse rows from a sheet tab into structured order items.
 * Handles multi-row orders (continuation rows with no order number).
 */
function parseOrderItems(rows, options = {}) {
  const sheetLabel = options.sheetLabel || '';
  const refundRows = options.refundRows instanceof Set ? options.refundRows : new Set();

  if (rows.length < 3) return [];

  const items = [];
  let currentOrder = null;

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const sheetRowNumber = i + 1;
    const sequenceNo = String(row[0] || '').trim();
    const date = normalizeSheetDate(row[1]);
    const name = String(row[2] || '').trim();
    const orderNumber = String(row[3] || '').trim();
    const productUrl = String(row[4] || '').trim();
    const sellerNo = String(row[5] || '').trim();
    const productName = String(row[6] || '').trim();
    const cost = parseKRW(row[7]);
    const shipping = parseKRW(row[8]);
    const payment = String(row[9] || '').toUpperCase() === 'TRUE';
    const delivery = String(row[10] || '').toUpperCase() === 'TRUE';
    const note = String(row[11] || '').trim();

    if (sequenceNo && date) {
      currentOrder = {
        sequenceNo,
        date,
        name,
        orderNumber: orderNumber || sequenceNo,
      };
    }

    if (!currentOrder) continue;

    const refundSignals = {
      redText: refundRows.has(sheetRowNumber),
      noteKeyword: hasRefundNoteKeyword(note),
    };
    const isRefund = refundSignals.redText || refundSignals.noteKeyword;
    const hasMonetaryValue = cost > 0 || shipping > 0;
    const hasContent = hasMonetaryValue || productName || note || isRefund;

    if (!hasContent) continue;

    items.push({
      sheetLabel,
      rowNumber: sheetRowNumber,
      sequenceNo: currentOrder.sequenceNo,
      orderNumber: currentOrder.orderNumber,
      orderKey: currentOrder.orderNumber || `${sheetLabel}:${currentOrder.sequenceNo}`,
      date: currentOrder.date,
      name: currentOrder.name,
      productUrl,
      sellerNo,
      productName,
      cost,
      shipping,
      payment,
      delivery,
      note,
      isRefund,
      refundSignals,
    });
  }

  return items;
}

function createOrderSummary(item) {
  return {
    orderKey: item.orderKey,
    orderNumber: item.orderNumber,
    sequenceNo: item.sequenceNo,
    date: item.date,
    name: item.name,
    sheetLabel: item.sheetLabel,
    purchaseItemCount: 0,
    refundItemCount: 0,
    cost: 0,
    shipping: 0,
    items: [],
  };
}

function createPeriodAggregate() {
  return {
    cost: 0,
    shipping: 0,
    items: 0,
    purchases: 0,
    refunds: 0,
    refundOnlyOrders: 0,
    partiallyRefundedOrders: 0,
  };
}

function aggregateCOGSItems(items) {
  const orderMap = new Map();

  for (const item of items) {
    const orderKey = item.orderKey || `${item.sheetLabel}:${item.rowNumber}`;
    const order = orderMap.get(orderKey) || createOrderSummary(item);

    order.items.push(item);
    if (item.isRefund) {
      order.refundItemCount++;
    } else if (item.cost > 0 || item.shipping > 0) {
      order.purchaseItemCount++;
      order.cost += item.cost;
      order.shipping += item.shipping;
    }

    orderMap.set(orderKey, order);
  }

  let totalCOGS = 0;
  let totalShipping = 0;
  let itemCount = 0;
  let purchaseCount = 0;
  let refundCount = 0;
  let refundOnlyOrderCount = 0;
  let partiallyRefundedOrderCount = 0;

  const dailyCOGS = {};
  const monthlyCOGS = {};
  const orders = [];

  for (const order of orderMap.values()) {
    const hasPurchase = order.purchaseItemCount > 0 || order.cost > 0 || order.shipping > 0;
    const hasRefund = order.refundItemCount > 0;

    const summary = {
      orderKey: order.orderKey,
      orderNumber: order.orderNumber,
      sequenceNo: order.sequenceNo,
      date: order.date,
      name: order.name,
      sheetLabel: order.sheetLabel,
      itemCount: order.purchaseItemCount,
      refundItemCount: order.refundItemCount,
      cost: order.cost,
      shipping: order.shipping,
      hasPurchase,
      hasRefund,
      isRefundOnly: hasRefund && !hasPurchase,
      isPartiallyRefunded: hasRefund && hasPurchase,
    };
    orders.push(summary);

    if (!order.date || (!hasPurchase && !hasRefund)) {
      continue;
    }

    if (!dailyCOGS[order.date]) dailyCOGS[order.date] = createPeriodAggregate();
    const monthKey = order.date.slice(0, 7);
    if (!monthlyCOGS[monthKey]) monthlyCOGS[monthKey] = createPeriodAggregate();

    if (hasPurchase) {
      totalCOGS += order.cost;
      totalShipping += order.shipping;
      itemCount += order.purchaseItemCount;
      purchaseCount++;

      dailyCOGS[order.date].cost += order.cost;
      dailyCOGS[order.date].shipping += order.shipping;
      dailyCOGS[order.date].items += order.purchaseItemCount;
      dailyCOGS[order.date].purchases++;

      monthlyCOGS[monthKey].cost += order.cost;
      monthlyCOGS[monthKey].shipping += order.shipping;
      monthlyCOGS[monthKey].items += order.purchaseItemCount;
      monthlyCOGS[monthKey].purchases++;
    }

    if (hasRefund) {
      refundCount++;
      dailyCOGS[order.date].refunds++;
      monthlyCOGS[monthKey].refunds++;

      if (summary.isRefundOnly) {
        refundOnlyOrderCount++;
        dailyCOGS[order.date].refundOnlyOrders++;
        monthlyCOGS[monthKey].refundOnlyOrders++;
      } else {
        partiallyRefundedOrderCount++;
        dailyCOGS[order.date].partiallyRefundedOrders++;
        monthlyCOGS[monthKey].partiallyRefundedOrders++;
      }
    }
  }

  return {
    totalCOGS,
    totalShipping,
    totalCOGSWithShipping: totalCOGS + totalShipping,
    itemCount,
    orderCount: orders.length,
    purchaseCount,
    refundCount,
    refundOnlyOrderCount,
    partiallyRefundedOrderCount,
    dailyCOGS,
    monthlyCOGS,
    items,
    orders,
    lastFetched: new Date().toISOString(),
  };
}

/**
 * Fetch all COGS data from all configured sheet tabs and compute aggregated metrics.
 */
async function fetchAllCOGS() {
  console.log('[COGS] Fetching COGS data from Google Sheets...');

  let refundMarkers = {};
  try {
    refundMarkers = await fetchWorkbookRefundMarkers();
  } catch (err) {
    console.warn('[COGS]   ⚠ Workbook style parse failed, falling back to note-only refund detection:', err.message);
  }

  const allItems = [];

  for (const [label, gid] of Object.entries(SHEET_GIDS)) {
    try {
      const rows = await fetchSheetCSV(gid);
      const items = parseOrderItems(rows, {
        sheetLabel: label,
        refundRows: refundMarkers[label] || new Set(),
      });
      allItems.push(...items);
      console.log(`[COGS]   → Sheet "${label}": ${items.length} rows`);
    } catch (err) {
      console.warn(`[COGS]   ⚠ Sheet "${label}" (gid=${gid}) failed:`, err.message);
    }
  }

  const result = aggregateCOGSItems(allItems);

  console.log(
    `[COGS] Total: ₩${result.totalCOGS.toLocaleString()} product + ` +
    `₩${result.totalShipping.toLocaleString()} shipping ` +
    `(${result.purchaseCount} purchase orders, ${result.refundCount} refund-marked orders)`
  );

  return result;
}

module.exports = {
  fetchAllCOGS,
  fetchSheetCSV,
  fetchWorkbookRefundMarkers,
  parseOrderItems,
  parseCSV,
  parseKRW,
  aggregateCOGSItems,
};
