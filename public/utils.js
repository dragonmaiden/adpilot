/* ============================================
   AdPilot — Shared Client Utilities
   ============================================ */

/**
 * Format a KRW value for display (e.g. ₩1.2M, ₩450K, ₩12,000).
 * @param {number} val
 * @returns {string}
 */
function formatKRW(val) {
  if (val >= 1000000) return '\u20a9' + (val / 1000000).toFixed(1) + 'M';
  if (val >= 1000) return '\u20a9' + (val / 1000).toFixed(0) + 'K';
  return '\u20a9' + Math.round(val).toLocaleString();
}
