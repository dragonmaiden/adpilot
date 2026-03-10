// ═══════════════════════════════════════════════════════
// AdPilot — Telegram Approval System
// Sends approval requests before any $ decision
// ═══════════════════════════════════════════════════════

const config = require('../config');

const BOT_TOKEN = config.telegram.botToken;
const CHAT_ID = config.telegram.chatId;
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Pending approvals waiting for user response
const pendingApprovals = new Map();

// ── Send a plain text message ──
async function sendMessage(text, parseMode = 'HTML') {
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: parseMode,
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error('[TELEGRAM] Send failed:', data.description);
    return data;
  } catch (err) {
    console.error('[TELEGRAM] Send error:', err.message);
    return null;
  }
}

// ── Send approval request with inline buttons ──
async function requestApproval(optimization) {
  const approvalId = `approve_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const priorityEmoji = {
    critical: '🚨',
    high: '⚠️',
    medium: 'ℹ️',
    low: '💡',
  };

  const typeEmoji = {
    budget: '💰',
    status: '⏸',
    bid: '📊',
    creative: '🎨',
    schedule: '🕐',
    targeting: '🎯',
  };

  const emoji = typeEmoji[optimization.type] || '⚡';
  const pEmoji = priorityEmoji[optimization.priority] || '';

  const text = `${emoji} <b>AdPilot Approval Request</b> ${pEmoji}

<b>Action:</b> ${optimization.action}
<b>Target:</b> ${optimization.targetName}
<b>Priority:</b> ${optimization.priority.toUpperCase()}

<b>Reason:</b>
${optimization.reason}

<b>Expected Impact:</b>
${optimization.impact}

<i>Reply with the buttons below to approve or reject.</i>`;

  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `${approvalId}_yes` },
              { text: '❌ Reject', callback_data: `${approvalId}_no` },
            ],
          ],
        },
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error('[TELEGRAM] Approval request failed:', data.description);
      return null;
    }

    // Store pending approval
    pendingApprovals.set(approvalId, {
      optimization,
      messageId: data.result?.message_id,
      requestedAt: Date.now(),
      status: 'pending', // pending | approved | rejected | expired
      resolveCallback: null,
    });

    console.log(`[TELEGRAM] Approval requested: ${approvalId} for "${optimization.action}"`);
    return approvalId;
  } catch (err) {
    console.error('[TELEGRAM] Approval request error:', err.message);
    return null;
  }
}

// ── Wait for approval (with timeout) ──
function waitForApproval(approvalId, timeoutMs = 300000) {
  // Default 5-minute timeout
  return new Promise((resolve) => {
    const pending = pendingApprovals.get(approvalId);
    if (!pending) {
      resolve({ approved: false, reason: 'Approval not found' });
      return;
    }

    // Already resolved (from polling)
    if (pending.status === 'approved') {
      resolve({ approved: true });
      return;
    }
    if (pending.status === 'rejected') {
      resolve({ approved: false, reason: 'Rejected by user' });
      return;
    }

    // Set up callback for when response comes in
    pending.resolveCallback = resolve;

    // Timeout
    setTimeout(() => {
      if (pending.status === 'pending') {
        pending.status = 'expired';
        pendingApprovals.delete(approvalId);
        // Edit the message to show it expired
        editApprovalMessage(pending.messageId, '⏰ Expired — no response within 5 minutes. Action skipped.');
        resolve({ approved: false, reason: 'Timeout — no response' });
      }
    }, timeoutMs);
  });
}

// ── Process callback from Telegram (button click) ──
function processCallback(callbackData, callbackQueryId) {
  const parts = callbackData.split('_');
  const decision = parts.pop(); // 'yes' or 'no'
  const approvalId = parts.join('_');

  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    answerCallback(callbackQueryId, 'This approval has expired.');
    return null;
  }

  const approved = decision === 'yes';
  pending.status = approved ? 'approved' : 'rejected';

  // Answer the callback to remove loading state on button
  answerCallback(callbackQueryId, approved ? '✅ Approved! Executing now...' : '❌ Rejected. Action cancelled.');

  // Edit the original message to show the decision
  const statusText = approved
    ? '✅ <b>APPROVED</b> — Executing now...'
    : '❌ <b>REJECTED</b> — Action cancelled.';
  editApprovalMessage(pending.messageId, statusText);

  // Resolve the waiting promise
  if (pending.resolveCallback) {
    pending.resolveCallback({ approved, reason: approved ? 'User approved' : 'User rejected' });
  }

  console.log(`[TELEGRAM] Approval ${approvalId}: ${approved ? 'APPROVED' : 'REJECTED'}`);
  return { approvalId, approved, optimization: pending.optimization };
}

// ── Answer callback query (removes loading on button) ──
async function answerCallback(callbackQueryId, text) {
  try {
    await fetch(`${API_BASE}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: true,
      }),
    });
  } catch (err) {
    console.error('[TELEGRAM] Answer callback error:', err.message);
  }
}

// ── Edit an approval message to show result ──
async function editApprovalMessage(messageId, appendText) {
  if (!messageId) return;
  try {
    // We can't easily append, so we just edit reply_markup to remove buttons
    await fetch(`${API_BASE}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        message_id: messageId,
        reply_markup: { inline_keyboard: [] },
      }),
    });

    // Send a follow-up with the result
    await sendMessage(appendText);
  } catch (err) {
    console.error('[TELEGRAM] Edit message error:', err.message);
  }
}

// ── Send scan summary notification ──
async function sendScanSummary(scanResult) {
  const opts = scanResult.optimizations || [];
  if (opts.length === 0) {
    // Don't spam if nothing found
    return;
  }

  const priorityEmoji = { critical: '🚨', high: '⚠️', medium: 'ℹ️', low: '💡' };
  const typeEmoji = { budget: '💰', status: '⏸', bid: '📊', creative: '🎨', schedule: '🕐', targeting: '🎯' };

  // Build detailed list of each optimization
  const details = opts.map((o, i) => {
    const pEmoji = priorityEmoji[o.priority] || '⚡';
    const tEmoji = typeEmoji[o.type] || '⚡';
    return `${pEmoji} <b>${o.priority.toUpperCase()}</b> ${tEmoji} <b>${o.targetName}</b>\n    └ ${o.action}\n    └ <i>${o.reason}</i>`;
  }).join('\n\n');

  // Stats from scan
  const stats = scanResult.stats || {};
  const statsLine = stats.activeAds
    ? `\n📊 ${stats.activeCampaigns} campaigns · ${stats.activeAds} ads active · $${stats.totalSpend7d} spent (7d)`
    : '';

  const text = `🔍 <b>AdPilot Scan Complete</b>${statsLine}

Found <b>${opts.length}</b> suggestion${opts.length > 1 ? 's' : ''}:

${details}

<i>💵 Any $ decisions will require your approval first.</i>`;

  await sendMessage(text);
}

// ── Poll for updates (callback button presses) ──
let lastUpdateId = 0;
let pollingActive = false;

async function pollUpdates() {
  if (pollingActive) return;
  pollingActive = true;

  try {
    const res = await fetch(`${API_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
    const data = await res.json();

    if (data.ok && data.result) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;

        // Handle callback queries (button presses)
        if (update.callback_query) {
          const cb = update.callback_query;
          processCallback(cb.data, cb.id);
        }
      }
    }
  } catch (err) {
    // Polling error — will retry on next interval
  }

  pollingActive = false;
}

// Start polling loop
let pollTimer = null;

function startPolling() {
  console.log('[TELEGRAM] Starting callback polling...');
  pollTimer = setInterval(pollUpdates, 2000); // Poll every 2 seconds
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    console.log('[TELEGRAM] Polling stopped');
  }
}

// ── Getters ──
function getPendingApprovals() {
  const result = [];
  for (const [id, data] of pendingApprovals) {
    result.push({ id, ...data, optimization: data.optimization });
  }
  return result;
}

module.exports = {
  sendMessage,
  requestApproval,
  waitForApproval,
  processCallback,
  sendScanSummary,
  startPolling,
  stopPolling,
  getPendingApprovals,
};
