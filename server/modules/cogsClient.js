// ═══════════════════════════════════════════════════════
// AdPilot — COGS Client (Google Sheets Integration)
// Reads cost, purchase, and refund markers from the public
// Google Sheet. Red text in the workbook is treated as a
// refund marker, with note keywords as a fallback.
// ═══════════════════════════════════════════════════════

const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const config = require('../config');
const googleSheetsAuthService = require('../services/googleSheetsAuthService');

const SPREADSHEET_ID = config.cogs.spreadsheetId;
const SHEET_GIDS = config.cogs.sheetGids;
const PRIMARY_REFUND_COLUMNS = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']);
const REFUND_NOTE_KEYWORDS = ['취소', '환불', '반환'];
const PENDING_RECOVERY_NOTE_KEYWORDS = ['환급대기', '환불대기', '회수대기', '정산대기', '잔액추적', '중간상', '보류'];
const MONTH_SHEET_RE = /^\s*\d{1,2}\s*월(?:\s|$)/;

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
async function fetchSheetCSV(ref) {
  const gid = ref && typeof ref === 'object' ? String(ref.gid || '').trim() : String(ref || '').trim();
  const sheetName = ref && typeof ref === 'object' ? String(ref.sheetName || '').trim() : '';

  if (googleSheetsAuthService.isConfigured()) {
    const resolveSheetNameByGid = async () => {
      if (!gid) return '';
      const metadata = await googleSheetsAuthService.fetchSpreadsheetMetadata(SPREADSHEET_ID);
      const matchedSheet = asArray(metadata?.sheets).find(sheet => String(sheet?.properties?.sheetId ?? '') === gid);
      return String(matchedSheet?.properties?.title || '').trim();
    };

    let resolvedSheetName = sheetName;
    if (!resolvedSheetName && gid) {
      resolvedSheetName = await resolveSheetNameByGid();
    }
    if (!resolvedSheetName) {
      throw new Error('Google Sheets API read requires a sheet title');
    }

    try {
      return await googleSheetsAuthService.fetchSheetValues(SPREADSHEET_ID, resolvedSheetName);
    } catch (err) {
      if (!gid || !/Unable to parse range:/i.test(String(err?.message || ''))) {
        throw err;
      }

      const canonicalSheetName = await resolveSheetNameByGid();
      if (!canonicalSheetName || canonicalSheetName === resolvedSheetName) {
        throw err;
      }

      return googleSheetsAuthService.fetchSheetValues(SPREADSHEET_ID, canonicalSheetName);
    }
  }

  const url = gid
    ? `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${encodeURIComponent(gid)}`
    : `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Sheets CSV export failed (${gid ? `gid=${gid}` : `sheet=${sheetName}`}): HTTP ${res.status}`);
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

function parseSharedStrings(zip) {
  if (!zip.getEntry('xl/sharedStrings.xml')) {
    return [];
  }

  const parsed = xmlParser.parse(zip.readAsText('xl/sharedStrings.xml'));
  return asArray(parsed.sst?.si).map(entry => {
    if (typeof entry?.t === 'string') return entry.t;
    return asArray(entry?.r).map(run => String(run?.t || '')).join('');
  });
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
      name: String(sheet.name || '').trim(),
      path: target ? `xl/${target}` : null,
    };
  }).filter(sheet => sheet.path);
}

function normalizeSheetLabel(value) {
  return String(value || '').trim();
}

function getMonthSortKey(label) {
  const match = normalizeSheetLabel(label).match(/(\d{1,2})\s*월/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function getMonthIdentity(label) {
  const match = normalizeSheetLabel(label).match(/(\d{1,2}\s*월)/);
  return match ? match[1].replace(/\s+/g, '') : normalizeSheetLabel(label);
}

function isMonthlySheetLabel(label) {
  return MONTH_SHEET_RE.test(normalizeSheetLabel(label));
}

function buildSheetTargets(workbookSheets = []) {
  const workbookByIdentity = new Map(
    workbookSheets.map(sheet => [getMonthIdentity(sheet.name), sheet])
  );
  const targets = new Map();

  for (const [label, gid] of Object.entries(SHEET_GIDS)) {
    const normalizedLabel = normalizeSheetLabel(label);
    const identity = getMonthIdentity(normalizedLabel);
    const workbookSheet = workbookByIdentity.get(identity)
      || workbookSheets.find(sheet => getMonthIdentity(sheet.name) === identity)
      || workbookSheets.find(sheet => normalizeSheetLabel(sheet.name).includes(normalizedLabel));
    targets.set(identity, {
      label: normalizedLabel,
      gid: String(gid || workbookSheet?.gid || '').trim() || null,
      sheetName: workbookSheet?.name || normalizedLabel,
      path: workbookSheet?.path || null,
      discovered: false,
    });
  }

  for (const workbookSheet of workbookSheets) {
    const label = normalizeSheetLabel(workbookSheet.name);
    if (!isMonthlySheetLabel(label)) continue;
    const identity = getMonthIdentity(label);
    if (targets.has(identity)) {
      const existing = targets.get(identity);
      existing.sheetName = workbookSheet.name;
      existing.path = workbookSheet.path;
      targets.set(identity, existing);
      continue;
    }

    targets.set(identity, {
      label: identity,
      gid: String(workbookSheet.gid || '').trim() || null,
      sheetName: workbookSheet.name,
      path: workbookSheet.path,
      discovered: true,
    });
  }

  return Array.from(targets.values())
    .sort((left, right) => {
      const monthDelta = getMonthSortKey(left.label) - getMonthSortKey(right.label);
      if (monthDelta !== 0) return monthDelta;
      return left.label.localeCompare(right.label);
    });
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

function columnRefToIndex(ref) {
  const letters = getColumnFromCellRef(ref).toUpperCase();
  let index = 0;
  for (const char of letters) {
    index = (index * 26) + (char.charCodeAt(0) - 64);
  }
  return Math.max(index - 1, 0);
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

async function fetchWorkbookMetadata() {
  if (googleSheetsAuthService.isConfigured()) {
    const metadata = await googleSheetsAuthService.fetchSpreadsheetMetadata(SPREADSHEET_ID);
    return {
      zip: null,
      styles: null,
      sharedStrings: [],
      privateAccess: true,
      workbookSheets: asArray(metadata?.sheets).map(sheet => ({
        name: String(sheet?.properties?.title || '').trim(),
        gid: String(sheet?.properties?.sheetId || '').trim(),
        path: null,
      })),
    };
  }

  const zip = await fetchWorkbookZip();
  const workbookSheets = parseWorkbookSheets(zip);
  const styles = parseWorkbookStyles(zip);
  const sharedStrings = parseSharedStrings(zip);
  return { zip, workbookSheets, styles, sharedStrings };
}

function buildRefundMarkerMap(workbookMeta, sheetTargets) {
  if (!workbookMeta?.zip || !Array.isArray(sheetTargets) || sheetTargets.length === 0) {
    return {};
  }

  const workbookByLabel = new Map((workbookMeta.workbookSheets || []).map(sheet => [normalizeSheetLabel(sheet.name), sheet]));
  const markerMap = {};

  for (const target of sheetTargets) {
    const workbookSheet = workbookByLabel.get(normalizeSheetLabel(target.sheetName || target.label))
      || (target.path ? { path: target.path } : null);
    if (!workbookSheet?.path) continue;
    markerMap[target.label] = readWorksheetRefundRows(workbookMeta.zip, workbookSheet.path, workbookMeta.styles);
  }

  return markerMap;
}

function getCellTextValue(cell, sharedStrings = []) {
  if (!cell) return '';
  if (cell.is && typeof cell.is === 'object') {
    if (typeof cell.is.t === 'string') return cell.is.t;
    return asArray(cell.is.r).map(run => String(run?.t || '')).join('');
  }

  const raw = cell.v == null ? '' : String(cell.v);
  switch (String(cell.t || '').toLowerCase()) {
    case 's':
      return String(sharedStrings[Number.parseInt(raw, 10)] || '');
    case 'b':
      return raw === '1' ? 'TRUE' : 'FALSE';
    case 'str':
    case 'inlineStr':
      return raw;
    default:
      return raw;
  }
}

function readWorksheetRows(zip, sheetPath, sharedStrings = []) {
  const worksheet = xmlParser.parse(zip.readAsText(sheetPath)).worksheet || {};
  const rows = asArray(worksheet.sheetData?.row);

  return rows.map(row => {
    const cells = asArray(row.c);
    const columns = [];

    for (const cell of cells) {
      const index = columnRefToIndex(cell.r);
      columns[index] = getCellTextValue(cell, sharedStrings).trim();
    }

    return columns.map(value => value == null ? '' : String(value));
  }).filter(row => row.length > 0);
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

  if (/^\d{4,5}(?:\.\d+)?$/.test(input)) {
    const serial = Number.parseFloat(input);
    if (Number.isFinite(serial) && serial > 20000 && serial < 70000) {
      const excelEpochUtc = Date.UTC(1899, 11, 30);
      const date = new Date(excelEpochUtc + Math.round(serial) * 86400000);
      return date.toISOString().slice(0, 10);
    }
  }

  return input;
}

function hasRefundNoteKeyword(note) {
  const text = String(note || '').trim();
  return REFUND_NOTE_KEYWORDS.some(keyword => text.includes(keyword));
}

function hasPendingRecoveryNoteKeyword(note) {
  const text = String(note || '').trim();
  return PENDING_RECOVERY_NOTE_KEYWORDS.some(keyword => text.includes(keyword));
}

function noteContainsCurrency(note) {
  const text = String(note || '').trim();
  return /₩\s*\d|(?:^|[^\d])\d{1,3}(?:,\d{3})+(?:$|[^\d])/.test(text);
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function parseCompactDeliveryCell(value) {
  const text = String(value || '').trim();
  if (!text || !text.includes(':')) {
    return null;
  }

  const parsed = {};
  const parts = text
    .split(/\s*\|\s*|\n+/)
    .map(line => line.trim())
    .filter(Boolean);
  for (const line of parts) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;

    const label = line.slice(0, separatorIndex).trim().toLowerCase();
    const fieldValue = line.slice(separatorIndex + 1).trim();
    if (!fieldValue) continue;

    if (label === 'delivery note') parsed.note = fieldValue;
    if (label === 'customer name') parsed.customerName = fieldValue;
    if (label === 'phone') {
      parsed.ordererPhone = fieldValue;
      parsed.receiverPhone = parsed.receiverPhone || fieldValue;
    }
    if (label === 'receiver') parsed.receiverName = fieldValue;
    if (label === 'receiver phone') parsed.receiverPhone = fieldValue;
    if (label === 'zipcode') parsed.zipcode = fieldValue;
    if (label === 'address') {
      const zipcodeMatch = fieldValue.match(/^(\d{5})\s+(.+)$/);
      if (zipcodeMatch) {
        parsed.zipcode = parsed.zipcode || zipcodeMatch[1];
        parsed.address = zipcodeMatch[2].trim();
      } else {
        parsed.address = fieldValue;
      }
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
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
    const rawDate = String(row[1] || '').trim();
    const date = normalizeSheetDate(rawDate);
    const name = String(row[2] || '').trim();
    const orderNumber = String(row[3] || '').trim();
    const productUrl = String(row[4] || '').trim();
    const sellerNo = String(row[5] || '').trim();
    const productName = String(row[6] || '').trim();
    const cost = parseKRW(row[7]);
    const shipping = parseKRW(row[8]);
    const payment = String(row[9] || '').toUpperCase() === 'TRUE';
    const delivery = String(row[10] || '').toUpperCase() === 'TRUE';
    const noteCell = String(row[11] || '').trim();
    const compactDetails = parseCompactDeliveryCell(row[12]);
    const note = noteCell || compactDetails?.note || '';
    const ordererPhone = compactDetails?.ordererPhone || String(row[12] || '').trim();
    const receiverName = compactDetails?.receiverName || String(row[13] || '').trim();
    const receiverPhone = compactDetails?.receiverPhone || String(row[14] || '').trim();
    const zipcode = compactDetails?.zipcode || String(row[15] || '').trim();
    const address = compactDetails?.address || String(row[16] || '').trim();

    if (sequenceNo && date) {
      currentOrder = {
        sequenceNo,
        date,
        name: compactDetails?.customerName || name,
        orderNumber: orderNumber || sequenceNo,
        ordererPhone,
        receiverName,
        receiverPhone,
        zipcode,
        address,
      };
    }

    if (!currentOrder) continue;

    const refundSignals = {
      redText: refundRows.has(sheetRowNumber),
      noteKeyword: hasRefundNoteKeyword(note),
    };
    const isRefund = refundSignals.redText || refundSignals.noteKeyword;
    const pendingRecoverySignals = {
      noteKeyword: hasPendingRecoveryNoteKeyword(note),
    };
    const isPendingRecovery = !isRefund && productName && cost === 0 && shipping === 0 && pendingRecoverySignals.noteKeyword;
    const hasMonetaryValue = cost > 0 || shipping > 0;
    const hasContent = hasMonetaryValue || productName || note || isRefund || isPendingRecovery;

    if (!hasContent) continue;

    const warnings = [];
    if (!isRefund && !isPendingRecovery && productName && cost === 0 && shipping === 0) {
      warnings.push('missing_cost_and_shipping');
    }
    if (!isRefund && noteContainsCurrency(note)) {
      warnings.push('currency_in_note');
    }
    if (looksLikeUrl(orderNumber)) {
      warnings.push('order_number_looks_like_url');
    }

    items.push({
      sheetLabel,
      rowNumber: sheetRowNumber,
      sequenceNo: currentOrder.sequenceNo,
      orderNumber: currentOrder.orderNumber,
      orderKey: currentOrder.orderNumber || `${sheetLabel}:${currentOrder.sequenceNo}`,
      date: currentOrder.date,
      name: currentOrder.name,
      ordererPhone: currentOrder.ordererPhone,
      receiverName: currentOrder.receiverName,
      receiverPhone: currentOrder.receiverPhone,
      zipcode: currentOrder.zipcode,
      address: currentOrder.address,
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
      isPendingRecovery,
      pendingRecoverySignals,
      warnings,
      rawDate,
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
    ordererPhone: item.ordererPhone || '',
    receiverName: item.receiverName || '',
    receiverPhone: item.receiverPhone || '',
    zipcode: item.zipcode || '',
    address: item.address || '',
    sheetLabel: item.sheetLabel,
    purchaseItemCount: 0,
    costedItemCount: 0,
    missingCostItemCount: 0,
    pendingRecoveryItemCount: 0,
    refundItemCount: 0,
    cost: 0,
    shipping: 0,
    refundCost: 0,
    refundShipping: 0,
    items: [],
    productNames: new Set(),
  };
}

function createPeriodAggregate() {
  return {
    cost: 0,
    shipping: 0,
    purchaseCost: 0,
    purchaseShipping: 0,
    refundCost: 0,
    refundShipping: 0,
    items: 0,
    costedItems: 0,
    missingCostItems: 0,
    pendingRecoveryItems: 0,
    purchases: 0,
    completePurchases: 0,
    incompletePurchases: 0,
    pendingRecoveryOrders: 0,
    refunds: 0,
    refundOnlyOrders: 0,
    partiallyRefundedOrders: 0,
    costCoverageRatio: 1,
    isComplete: true,
  };
}

function finalizePeriodAggregate(aggregate) {
  const purchaseItems = Number(aggregate.items || 0);
  const costedItems = Number(aggregate.costedItems || 0);
  aggregate.cost = Number(aggregate.purchaseCost || 0) - Number(aggregate.refundCost || 0);
  aggregate.shipping = Number(aggregate.purchaseShipping || 0) - Number(aggregate.refundShipping || 0);
  aggregate.costCoverageRatio = purchaseItems > 0
    ? Number((costedItems / purchaseItems).toFixed(3))
    : 1;
  aggregate.isComplete = Number(aggregate.missingCostItems || 0) === 0;
  return aggregate;
}

function buildValidationSummary(items) {
  const rowsWithWarnings = [];
  let missingValueRows = 0;
  let currencyInNoteRows = 0;
  let malformedOrderNumberRows = 0;
  let refundValueRows = 0;

  for (const item of items) {
    const warnings = Array.isArray(item?.warnings) ? item.warnings : [];
    if (warnings.includes('missing_cost_and_shipping')) missingValueRows += 1;
    if (warnings.includes('currency_in_note')) currencyInNoteRows += 1;
    if (warnings.includes('order_number_looks_like_url')) malformedOrderNumberRows += 1;
    if (item?.isRefund && (Number(item?.cost || 0) > 0 || Number(item?.shipping || 0) > 0)) refundValueRows += 1;

    if (warnings.length > 0) {
      rowsWithWarnings.push({
        sheetLabel: item.sheetLabel,
        rowNumber: item.rowNumber,
        date: item.date,
        orderNumber: item.orderNumber,
        productName: item.productName,
        note: item.note,
        warnings,
      });
    }
  }

  return {
    rowsWithWarnings: rowsWithWarnings.length,
    missingValueRows,
    currencyInNoteRows,
    malformedOrderNumberRows,
    refundValueRows,
    samples: rowsWithWarnings.slice(0, 10),
  };
}

function aggregateCOGSItems(items) {
  const orderMap = new Map();

  for (const item of items) {
    const orderKey = item.orderKey || `${item.sheetLabel}:${item.rowNumber}`;
    const order = orderMap.get(orderKey) || createOrderSummary(item);

    order.items.push(item);
    if (item.productName) {
      order.productNames.add(item.productName);
    }
    if (item.isRefund) {
      order.refundItemCount++;
      order.refundCost += item.cost;
      order.refundShipping += item.shipping;
    } else if (item.isPendingRecovery) {
      order.pendingRecoveryItemCount++;
    } else {
      order.purchaseItemCount++;
      if (item.cost > 0 || item.shipping > 0) {
        order.costedItemCount++;
      } else {
        order.missingCostItemCount++;
      }
      order.cost += item.cost;
      order.shipping += item.shipping;
    }

    orderMap.set(orderKey, order);
  }

  let totalPurchaseCOGS = 0;
  let totalPurchaseShipping = 0;
  let totalRefundCOGS = 0;
  let totalRefundShipping = 0;
  let itemCount = 0;
  let costedItemCount = 0;
  let missingCostItemCount = 0;
  let pendingRecoveryItemCount = 0;
  let purchaseCount = 0;
  let completePurchaseCount = 0;
  let incompletePurchaseCount = 0;
  let pendingRecoveryOrderCount = 0;
  let refundCount = 0;
  let refundOnlyOrderCount = 0;
  let partiallyRefundedOrderCount = 0;

  const dailyCOGS = {};
  const monthlyCOGS = {};
  const orders = [];

  for (const order of orderMap.values()) {
    const hasPurchase = order.purchaseItemCount > 0;
    const hasRefund = order.refundItemCount > 0;
    const hasPendingRecovery = order.pendingRecoveryItemCount > 0;
    const hasIncompleteCosting = hasPurchase && order.missingCostItemCount > 0;
    const costCoverageRatio = hasPurchase
      ? Number((order.costedItemCount / order.purchaseItemCount).toFixed(3))
      : 1;

    const summary = {
      orderKey: order.orderKey,
      orderNumber: order.orderNumber,
      sequenceNo: order.sequenceNo,
      date: order.date,
      name: order.name,
      ordererPhone: order.ordererPhone,
      receiverName: order.receiverName,
      receiverPhone: order.receiverPhone,
      zipcode: order.zipcode,
      address: order.address,
      productNames: [...order.productNames],
      sheetLabel: order.sheetLabel,
      itemCount: order.purchaseItemCount,
      costedItemCount: order.costedItemCount,
      missingCostItemCount: order.missingCostItemCount,
      pendingRecoveryItemCount: order.pendingRecoveryItemCount,
      refundItemCount: order.refundItemCount,
      cost: order.cost,
      shipping: order.shipping,
      refundCost: order.refundCost,
      refundShipping: order.refundShipping,
      netCost: order.cost - order.refundCost,
      netShipping: order.shipping - order.refundShipping,
      hasPurchase,
      hasRefund,
      hasPendingRecovery,
      isRefundOnly: hasRefund && !hasPurchase,
      isPartiallyRefunded: hasRefund && hasPurchase,
      hasIncompleteCosting,
      costCoverageRatio,
      isComplete: !hasIncompleteCosting,
    };
    orders.push(summary);

    if (!order.date || (!hasPurchase && !hasRefund && !hasPendingRecovery)) {
      continue;
    }

    if (!dailyCOGS[order.date]) dailyCOGS[order.date] = createPeriodAggregate();
    const monthKey = order.date.slice(0, 7);
    if (!monthlyCOGS[monthKey]) monthlyCOGS[monthKey] = createPeriodAggregate();

    if (hasPurchase) {
      totalPurchaseCOGS += order.cost;
      totalPurchaseShipping += order.shipping;
      itemCount += order.purchaseItemCount;
      costedItemCount += order.costedItemCount;
      missingCostItemCount += order.missingCostItemCount;
      purchaseCount++;
      if (hasIncompleteCosting) {
        incompletePurchaseCount++;
      } else {
        completePurchaseCount++;
      }

      dailyCOGS[order.date].purchaseCost += order.cost;
      dailyCOGS[order.date].purchaseShipping += order.shipping;
      dailyCOGS[order.date].items += order.purchaseItemCount;
      dailyCOGS[order.date].costedItems += order.costedItemCount;
      dailyCOGS[order.date].missingCostItems += order.missingCostItemCount;
      dailyCOGS[order.date].purchases++;
      if (hasIncompleteCosting) {
        dailyCOGS[order.date].incompletePurchases++;
      } else {
        dailyCOGS[order.date].completePurchases++;
      }

      monthlyCOGS[monthKey].purchaseCost += order.cost;
      monthlyCOGS[monthKey].purchaseShipping += order.shipping;
      monthlyCOGS[monthKey].items += order.purchaseItemCount;
      monthlyCOGS[monthKey].costedItems += order.costedItemCount;
      monthlyCOGS[monthKey].missingCostItems += order.missingCostItemCount;
      monthlyCOGS[monthKey].purchases++;
      if (hasIncompleteCosting) {
        monthlyCOGS[monthKey].incompletePurchases++;
      } else {
        monthlyCOGS[monthKey].completePurchases++;
      }
    }

    if (hasPendingRecovery) {
      pendingRecoveryItemCount += order.pendingRecoveryItemCount;
      pendingRecoveryOrderCount++;
      dailyCOGS[order.date].pendingRecoveryItems += order.pendingRecoveryItemCount;
      dailyCOGS[order.date].pendingRecoveryOrders++;
      monthlyCOGS[monthKey].pendingRecoveryItems += order.pendingRecoveryItemCount;
      monthlyCOGS[monthKey].pendingRecoveryOrders++;
    }

    if (hasRefund) {
      refundCount++;
      totalRefundCOGS += order.refundCost;
      totalRefundShipping += order.refundShipping;
      dailyCOGS[order.date].refunds++;
      dailyCOGS[order.date].refundCost += order.refundCost;
      dailyCOGS[order.date].refundShipping += order.refundShipping;
      monthlyCOGS[monthKey].refunds++;
      monthlyCOGS[monthKey].refundCost += order.refundCost;
      monthlyCOGS[monthKey].refundShipping += order.refundShipping;

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

  Object.values(dailyCOGS).forEach(finalizePeriodAggregate);
  Object.values(monthlyCOGS).forEach(finalizePeriodAggregate);

  const totalCOGS = totalPurchaseCOGS - totalRefundCOGS;
  const totalShipping = totalPurchaseShipping - totalRefundShipping;

  return {
    totalCOGS,
    totalShipping,
    totalCOGSWithShipping: totalCOGS + totalShipping,
    grossCOGS: totalPurchaseCOGS,
    grossShipping: totalPurchaseShipping,
    refundCOGS: totalRefundCOGS,
    refundShipping: totalRefundShipping,
    itemCount,
    costedItemCount,
    missingCostItemCount,
    pendingRecoveryItemCount,
    orderCount: orders.length,
    purchaseCount,
    completePurchaseCount,
    incompletePurchaseCount,
    pendingRecoveryOrderCount,
    refundCount,
    refundOnlyOrderCount,
    partiallyRefundedOrderCount,
    dailyCOGS,
    monthlyCOGS,
    items,
    orders,
    validation: buildValidationSummary(items),
    lastFetched: new Date().toISOString(),
  };
}

/**
 * Fetch all COGS data from all configured sheet tabs and compute aggregated metrics.
 */
async function fetchAllCOGS() {
  console.log('[COGS] Fetching COGS data from Google Sheets...');

  let workbookMeta = null;
  try {
    workbookMeta = await fetchWorkbookMetadata();
  } catch (err) {
    console.warn('[COGS]   ⚠ Workbook style parse failed, falling back to note-only refund detection:', err.message);
  }

  if (!googleSheetsAuthService.isConfigured()) {
    console.warn('[COGS]   ⚠ Using public Google Sheets export path. Customer PII should only live in a private sheet.');
  }

  const sheetTargets = buildSheetTargets(workbookMeta?.workbookSheets || []);
  const fallbackTargets = sheetTargets.length > 0
    ? sheetTargets
    : Object.entries(SHEET_GIDS).map(([label, gid]) => ({
        label: normalizeSheetLabel(label),
        gid: String(gid || '').trim() || null,
        sheetName: normalizeSheetLabel(label),
        path: null,
        discovered: false,
      }));
  const refundMarkers = buildRefundMarkerMap(workbookMeta, fallbackTargets);
  const allItems = [];
  const sheets = [];

  for (const target of fallbackTargets) {
    try {
      const rows = (workbookMeta?.privateAccess || target.gid || !target.path)
        ? await fetchSheetCSV({ gid: target.gid, sheetName: target.sheetName || target.label })
        : readWorksheetRows(workbookMeta.zip, target.path, workbookMeta.sharedStrings);
      const items = parseOrderItems(rows, {
        sheetLabel: target.label,
        refundRows: refundMarkers[target.label] || new Set(),
      });
      allItems.push(...items);
      sheets.push({
        label: target.label,
        sheetName: target.sheetName,
        gid: target.gid,
        discovered: !!target.discovered,
        itemRows: items.length,
      });
      console.log(`[COGS]   → Sheet "${target.label}": ${items.length} rows`);
    } catch (err) {
      console.warn(`[COGS]   ⚠ Sheet "${target.label}" (${target.gid ? `gid=${target.gid}` : `sheet=${target.sheetName}`}) failed:`, err.message);
    }
  }

  const result = aggregateCOGSItems(allItems);
  result.sheets = sheets;

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
  fetchWorkbookMetadata,
  buildSheetTargets,
  buildRefundMarkerMap,
  parseOrderItems,
  parseCompactDeliveryCell,
  parseCSV,
  parseKRW,
  normalizeSheetDate,
  aggregateCOGSItems,
};
