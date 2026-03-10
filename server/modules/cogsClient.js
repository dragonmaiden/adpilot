// ═══════════════════════════════════════════════════════
// AdPilot — COGS Client (Google Sheets Integration)
// Reads Cost of Goods Sold data from a public Google Sheet.
// Sheet: SHUE - Cost of goods sold (COGS)
// ═══════════════════════════════════════════════════════

const config = require('../config');

const SPREADSHEET_ID = config.cogs.spreadsheetId;
const SHEET_GIDS = config.cogs.sheetGids; // { feb: '0', mar: '456791124', ... }

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
    // Parse one row (may span multiple lines if fields contain newlines)
    while (i < len) {
      if (text[i] === '"') {
        // Quoted field — collect until closing quote
        i++; // skip opening quote
        let field = '';
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              // Escaped quote
              field += '"';
              i += 2;
            } else {
              // Closing quote
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field.trim());
        // After closing quote, expect comma or end-of-row
        if (i < len && text[i] === ',') {
          i++; // skip comma, continue to next field
        } else {
          // End of row (newline or EOF)
          if (i < len && text[i] === '\r') i++;
          if (i < len && text[i] === '\n') i++;
          break;
        }
      } else if (text[i] === '\r' || text[i] === '\n') {
        // Empty trailing field at end of row
        row.push('');
        if (text[i] === '\r') i++;
        if (i < len && text[i] === '\n') i++;
        break;
      } else {
        // Unquoted field — collect until comma or newline
        let field = '';
        while (i < len && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
          field += text[i];
          i++;
        }
        row.push(field.trim());
        if (i < len && text[i] === ',') {
          i++; // skip comma, continue to next field
        } else {
          // End of row
          if (i < len && text[i] === '\r') i++;
          if (i < len && text[i] === '\n') i++;
          break;
        }
      }
    }
    // Skip empty rows
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
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

/**
 * Parse rows from a sheet tab into structured order items.
 * Handles multi-row orders (continuation rows with no order number).
 *
 * Returns: [{ orderNo, date, name, cost, shipping, payment, delivery, productName }, ...]
 */
function parseOrderItems(rows) {
  // Row 0 = title row ("SHUE 2월 주문")
  // Row 1 = headers (No, date, name, order number, products urk, seller no, product name, Cost, Shipping cost, payment, delivery, note)
  // Row 2+ = data
  if (rows.length < 3) return [];

  const items = [];
  let currentOrder = null;

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 8) continue;

    const no = row[0];
    const date = row[1];
    const name = row[2];
    const orderNumber = row[3];
    const productName = row[6] || '';
    const cost = parseKRW(row[7]);
    const shipping = parseKRW(row[8]);
    const payment = (row[9] || '').toUpperCase() === 'TRUE';
    const delivery = (row[10] || '').toUpperCase() === 'TRUE';
    const note = row[11] || '';

    // Skip cancelled orders (note contains 취소)
    const isCancelled = note.includes('취소');

    if (no && date) {
      // New order line
      currentOrder = { no, date, name, orderNumber };
    }

    // Skip if no cost data or cancelled
    if (cost === 0 || isCancelled) continue;

    items.push({
      orderNo: currentOrder ? currentOrder.no : '',
      date: currentOrder ? currentOrder.date : '',
      name: currentOrder ? currentOrder.name : '',
      cost,
      shipping,
      payment,
      delivery,
      productName,
    });
  }

  return items;
}

/**
 * Fetch all COGS data from all sheet tabs and compute aggregated metrics.
 *
 * Returns: {
 *   totalCOGS: number,       // sum of all product costs (₩)
 *   totalShipping: number,   // sum of all shipping costs (₩)
 *   totalCOGSWithShipping: number,
 *   itemCount: number,       // total line items
 *   orderCount: number,      // distinct order numbers
 *   dailyCOGS: { "2026-02-08": { cost, shipping, items }, ... },
 *   monthlyCOGS: { "2026-02": { cost, shipping, items }, ... },
 *   items: [...],            // all parsed items
 *   lastFetched: ISO string,
 * }
 */
async function fetchAllCOGS() {
  console.log('[COGS] Fetching COGS data from Google Sheets...');

  const allItems = [];

  for (const [label, gid] of Object.entries(SHEET_GIDS)) {
    try {
      const rows = await fetchSheetCSV(gid);
      const items = parseOrderItems(rows);
      allItems.push(...items);
      console.log(`[COGS]   → Sheet "${label}": ${items.length} line items`);
    } catch (err) {
      console.warn(`[COGS]   ⚠ Sheet "${label}" (gid=${gid}) failed:`, err.message);
    }
  }

  // Aggregate
  let totalCOGS = 0;
  let totalShipping = 0;
  const dailyCOGS = {};
  const monthlyCOGS = {};
  const orderNos = new Set();

  for (const item of allItems) {
    totalCOGS += item.cost;
    totalShipping += item.shipping;
    if (item.orderNo) orderNos.add(item.orderNo);

    // Daily aggregation
    if (item.date) {
      if (!dailyCOGS[item.date]) dailyCOGS[item.date] = { cost: 0, shipping: 0, items: 0 };
      dailyCOGS[item.date].cost += item.cost;
      dailyCOGS[item.date].shipping += item.shipping;
      dailyCOGS[item.date].items++;

      // Monthly
      const mKey = item.date.slice(0, 7);
      if (!monthlyCOGS[mKey]) monthlyCOGS[mKey] = { cost: 0, shipping: 0, items: 0 };
      monthlyCOGS[mKey].cost += item.cost;
      monthlyCOGS[mKey].shipping += item.shipping;
      monthlyCOGS[mKey].items++;
    }
  }

  const result = {
    totalCOGS,
    totalShipping,
    totalCOGSWithShipping: totalCOGS + totalShipping,
    itemCount: allItems.length,
    orderCount: orderNos.size,
    dailyCOGS,
    monthlyCOGS,
    items: allItems,
    lastFetched: new Date().toISOString(),
  };

  console.log(`[COGS] Total: ₩${totalCOGS.toLocaleString()} product + ₩${totalShipping.toLocaleString()} shipping (${allItems.length} items, ${orderNos.size} orders)`);
  return result;
}

module.exports = {
  fetchAllCOGS,
  fetchSheetCSV,
  parseOrderItems,
  parseCSV,
  parseKRW,
};
