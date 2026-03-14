// ═══════════════════════════════════════════════════════
// AdPilot — Telegram Approval System
// Sends approval requests before any $ decision
// ═══════════════════════════════════════════════════════

const config = require('../config');
const telegramState = require('./telegramState');
const { buildScanSummaryPlan, shouldSendStartupMessage } = require('../services/telegramDigestService');

const BOT_TOKEN = typeof config.telegram.botToken === 'string'
  ? config.telegram.botToken.trim()
  : '';
const CHAT_ID = config.telegram.chatId != null
  ? String(config.telegram.chatId).trim()
  : '';
const API_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;

// Pending approvals waiting for user response
const pendingApprovals = new Map();
const statusState = {
  status: 'unknown',
  botTokenConfigured: Boolean(BOT_TOKEN),
  chatIdConfigured: Boolean(CHAT_ID),
  botTokenFormatValid: BOT_TOKEN_PATTERN.test(BOT_TOKEN),
  chatId: CHAT_ID || null,
  botUsername: null,
  botId: null,
  lastCheckedAt: null,
  lastOkAt: null,
  lastError: null,
};

function nowIso() {
  return new Date().toISOString();
}

function getConfigurationError() {
  if (!BOT_TOKEN) return 'TELEGRAM_BOT_TOKEN missing';
  if (!BOT_TOKEN_PATTERN.test(BOT_TOKEN)) return 'TELEGRAM_BOT_TOKEN format is invalid';
  if (!CHAT_ID) return 'TELEGRAM_CHAT_ID missing';
  return null;
}

function syncStatus(patch = {}) {
  Object.assign(statusState, patch, {
    botTokenConfigured: Boolean(BOT_TOKEN),
    chatIdConfigured: Boolean(CHAT_ID),
    botTokenFormatValid: BOT_TOKEN_PATTERN.test(BOT_TOKEN),
    chatId: CHAT_ID || null,
  });

  const configError = getConfigurationError();
  if (configError) {
    statusState.status = 'misconfigured';
    statusState.lastError = configError;
  } else if (!statusState.status || statusState.status === 'misconfigured') {
    statusState.status = 'unknown';
  }

  return statusState;
}

function getStatus() {
  return { ...syncStatus() };
}

function describeTelegramFailure(data, fallback = 'Telegram request failed') {
  const description = typeof data?.description === 'string' && data.description.trim()
    ? data.description.trim()
    : fallback;

  if (description === 'Not Found') {
    return 'Telegram API returned 404 Not Found. Check TELEGRAM_BOT_TOKEN.';
  }
  if (description.toLowerCase() === 'chat not found') {
    return 'Telegram chat not found. Check TELEGRAM_CHAT_ID and whether the bot can access that chat.';
  }
  return description;
}

async function probeConnection() {
  const configError = getConfigurationError();
  if (configError) {
    syncStatus({ status: 'misconfigured', lastCheckedAt: nowIso(), lastError: configError });
    return null;
  }

  try {
    const res = await fetch(`${API_BASE}/getMe`);
    const data = await res.json();
    const checkedAt = nowIso();

    if (!data.ok) {
      syncStatus({
        status: 'error',
        lastCheckedAt: checkedAt,
        lastError: describeTelegramFailure(data, 'Telegram getMe failed'),
      });
      return null;
    }

    syncStatus({
      status: 'connected',
      botUsername: data.result?.username || null,
      botId: data.result?.id || null,
      lastCheckedAt: checkedAt,
      lastOkAt: checkedAt,
      lastError: null,
    });
    return data.result;
  } catch (err) {
    syncStatus({
      status: 'error',
      lastCheckedAt: nowIso(),
      lastError: `Telegram connectivity check failed: ${err.message}`,
    });
    return null;
  }
}

// ── Send a plain text message ──
async function sendMessage(text, parseMode = 'HTML', options = {}) {
  const configError = getConfigurationError();
  if (configError) {
    syncStatus({ status: 'misconfigured', lastCheckedAt: nowIso(), lastError: configError });
    console.error('[TELEGRAM] Send skipped:', configError);
    return null;
  }

  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: parseMode,
        protect_content: options.protectContent === true,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      const message = describeTelegramFailure(data, 'Telegram sendMessage failed');
      syncStatus({ status: 'error', lastCheckedAt: nowIso(), lastError: message });
      console.error('[TELEGRAM] Send failed:', message);
    } else {
      const checkedAt = nowIso();
      syncStatus({
        status: 'connected',
        lastCheckedAt: checkedAt,
        lastOkAt: checkedAt,
        lastError: null,
      });
    }
    return data;
  } catch (err) {
    syncStatus({
      status: 'error',
      lastCheckedAt: nowIso(),
      lastError: `Telegram sendMessage failed: ${err.message}`,
    });
    console.error('[TELEGRAM] Send error:', err.message);
    return null;
  }
}

async function maybeSendStartupMessage() {
  const state = telegramState.getState();
  if (!shouldSendStartupMessage(state)) {
    return { skipped: true, reason: 'startup-cooldown' };
  }

  const result = await sendMessage('🤖 <b>AdPilot Agent Started</b>\n\nAutonomous scanning is active. Executable budget, bid, and status changes will request your approval here.');
  if (result?.ok) {
    telegramState.markStartupSent();
  }
  return result;
}

// ── Send approval request with inline buttons ──
async function requestApproval(optimization) {
  const configError = getConfigurationError();
  if (configError) {
    syncStatus({ status: 'misconfigured', lastCheckedAt: nowIso(), lastError: configError });
    console.error('[TELEGRAM] Approval request skipped:', configError);
    return null;
  }

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
      const message = describeTelegramFailure(data, 'Telegram approval request failed');
      syncStatus({ status: 'error', lastCheckedAt: nowIso(), lastError: message });
      console.error('[TELEGRAM] Approval request failed:', message);
      return null;
    }

    const checkedAt = nowIso();
    syncStatus({
      status: 'connected',
      lastCheckedAt: checkedAt,
      lastOkAt: checkedAt,
      lastError: null,
    });

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
    syncStatus({
      status: 'error',
      lastCheckedAt: nowIso(),
      lastError: `Telegram approval request failed: ${err.message}`,
    });
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
async function sendScanSummary(scanResult, latestData = null) {
  const plan = buildScanSummaryPlan(scanResult, latestData || {}, telegramState.getState());
  if (!plan.shouldSend || !plan.text) {
    return { skipped: true, reason: plan.reason, category: plan.category };
  }

  const result = await sendMessage(plan.text);
  if (result?.ok) {
    telegramState.markSummarySent({
      fingerprint: plan.fingerprint,
      category: plan.category,
    });
  }
  return result;
}

// ── Poll for updates (callback button presses) ──
let lastUpdateId = 0;
let pollingActive = false;

async function pollUpdates() {
  if (pollingActive) return;
  pollingActive = true;

  try {
    if (!API_BASE) {
      syncStatus({ status: 'misconfigured', lastCheckedAt: nowIso(), lastError: getConfigurationError() });
      return;
    }

    const res = await fetch(`${API_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
    const data = await res.json();

    if (data.ok && data.result) {
      const checkedAt = nowIso();
      syncStatus({
        status: 'connected',
        lastCheckedAt: checkedAt,
        lastOkAt: checkedAt,
        lastError: null,
      });
      for (const update of data.result) {
        lastUpdateId = update.update_id;

        // Handle callback queries (button presses)
        if (update.callback_query) {
          const cb = update.callback_query;
          processCallback(cb.data, cb.id);
        }
      }
    } else if (!data.ok) {
      syncStatus({
        status: 'error',
        lastCheckedAt: nowIso(),
        lastError: describeTelegramFailure(data, 'Telegram getUpdates failed'),
      });
    }
  } catch (err) {
    // Polling error — will retry on next interval
    syncStatus({
      status: 'error',
      lastCheckedAt: nowIso(),
      lastError: `Telegram polling failed: ${err.message}`,
    });
  } finally {
    pollingActive = false;
  }
}

// Start polling loop
let pollTimer = null;

function startPolling() {
  const configError = getConfigurationError();
  if (configError) {
    syncStatus({ status: 'misconfigured', lastCheckedAt: nowIso(), lastError: configError });
    console.warn('[TELEGRAM] Polling not started:', configError);
    return null;
  }
  if (pollTimer) {
    return pollTimer;
  }
  console.log('[TELEGRAM] Starting callback polling...');
  probeConnection().catch(() => {});
  pollTimer = setInterval(pollUpdates, 2000); // Poll every 2 seconds
  return pollTimer;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
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
  maybeSendStartupMessage,
  requestApproval,
  waitForApproval,
  processCallback,
  sendScanSummary,
  getStatus,
  probeConnection,
  startPolling,
  stopPolling,
  getPendingApprovals,
};
