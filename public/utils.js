/* ============================================
   AdPilot — Shared Client Utilities
   ============================================ */

/**
 * Format a KRW value for display with full won amounts.
 * @param {number} val
 * @returns {string}
 */
function formatKRW(val) {
  const amount = Number(val);
  const rounded = Number.isFinite(amount) ? Math.round(amount) : 0;
  return rounded >= 0
    ? '\u20a9' + rounded.toLocaleString()
    : '-\u20a9' + Math.abs(rounded).toLocaleString();
}
