// ═══════════════════════════════════════════════════════
// AdPilot — Telegram Notification Delivery
// Sends source-health and order notifications.
// ═══════════════════════════════════════════════════════

const config = require('../config');
const telegramState = require('./telegramState');
const { buildScanSummaryPlan } = require('../services/telegramDigestService');
const { buildDailySummaryReportPlan } = require('../services/dailyTelegramReportService');
const financialLedgerRepository = require('../db/financialLedgerRepository');

const BOT_TOKEN = typeof config.telegram.botToken === 'string'
  ? config.telegram.botToken.trim()
  : '';
const CHAT_ID = config.telegram.chatId != null
  ? String(config.telegram.chatId).trim()
  : '';
const PRIVATE_CHAT_ID = config.telegram.privateChatId != null
  ? String(config.telegram.privateChatId).trim()
  : '';
const REQUEST_TIMEOUT_MS = Number.isFinite(config.telegram.requestTimeoutMs) && config.telegram.requestTimeoutMs > 0
  ? config.telegram.requestTimeoutMs
  : 10000;
const API_BASE = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : '';
const BOT_TOKEN_PATTERN = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;

const statusState = {
  status: 'unknown',
  botTokenConfigured: Boolean(BOT_TOKEN),
  chatIdConfigured: Boolean(CHAT_ID),
  botTokenFormatValid: BOT_TOKEN_PATTERN.test(BOT_TOKEN),
  chatId: CHAT_ID || null,
  privateChatIdConfigured: Boolean(PRIVATE_CHAT_ID),
  privateChatSeparated: Boolean(PRIVATE_CHAT_ID && PRIVATE_CHAT_ID !== CHAT_ID),
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
    privateChatIdConfigured: Boolean(PRIVATE_CHAT_ID),
    privateChatSeparated: Boolean(PRIVATE_CHAT_ID && PRIVATE_CHAT_ID !== CHAT_ID),
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

function getPrivateDeliveryError() {
  const configError = getConfigurationError();
  if (configError) return configError;
  return null;
}

function getStatus() {
  return { ...syncStatus() };
}

function createTimeoutSignal(timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function requestTelegram(endpoint, { method = 'POST', payload = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const timeout = createTimeoutSignal(timeoutMs);
  const requestOptions = {
    method,
    headers: { 'Content-Type': 'application/json' },
    signal: timeout.signal,
  };

  if (payload != null) {
    requestOptions.body = JSON.stringify(payload);
  }

  try {
    const res = await fetch(`${API_BASE}/${endpoint}`, requestOptions);
    let data;
    try {
      data = await res.json();
    } catch (err) {
      data = {
        ok: false,
        description: `Telegram ${endpoint} returned invalid JSON: ${err.message}`,
      };
    }

    if (!res.ok && data?.ok !== false) {
      return {
        ...data,
        ok: false,
        description: `Telegram ${endpoint} failed with HTTP ${res.status}`,
      };
    }

    return data;
  } catch (err) {
    if (err?.name === 'AbortError') {
      return {
        ok: false,
        error_code: 'TIMEOUT',
        description: `Telegram ${endpoint} timed out after ${timeoutMs}ms`,
      };
    }
    throw err;
  } finally {
    timeout.clear();
  }
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
    const data = await requestTelegram('getMe', { method: 'GET' });
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

  const chatId = options.chatId != null ? String(options.chatId).trim() : CHAT_ID;
  if (!chatId) {
    const message = 'Telegram chat id is missing for sendMessage';
    syncStatus({ status: 'misconfigured', lastCheckedAt: nowIso(), lastError: message });
    console.error('[TELEGRAM] Send skipped:', message);
    return null;
  }

  try {
    const data = await requestTelegram('sendMessage', {
      payload: {
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        protect_content: options.protectContent === true,
      },
    });
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

async function sendPrivateMessage(text, parseMode = 'HTML', options = {}) {
  const privateError = getPrivateDeliveryError();
  if (privateError) {
    syncStatus({ status: 'error', lastCheckedAt: nowIso(), lastError: privateError });
    console.warn('[TELEGRAM] Private send skipped:', privateError);
    return { ok: false, skipped: true, reason: privateError };
  }

  return sendMessage(text, parseMode, {
    ...options,
    chatId: PRIVATE_CHAT_ID || CHAT_ID,
    protectContent: true,
  });
}

async function editMessageText(messageId, text, parseMode = 'HTML') {
  const configError = getConfigurationError();
  if (configError) {
    syncStatus({ status: 'misconfigured', lastCheckedAt: nowIso(), lastError: configError });
    console.error('[TELEGRAM] Edit skipped:', configError);
    return null;
  }

  if (!messageId) {
    return null;
  }

  try {
    const data = await requestTelegram('editMessageText', {
      payload: {
        chat_id: CHAT_ID,
        message_id: messageId,
        text,
        parse_mode: parseMode,
      },
    });
    if (!data.ok) {
      const message = describeTelegramFailure(data, 'Telegram editMessageText failed');
      if (message.toLowerCase().includes('message is not modified')) {
        return { ok: true, result: null, description: message };
      }
      syncStatus({ status: 'error', lastCheckedAt: nowIso(), lastError: message });
      console.error('[TELEGRAM] Edit failed:', message);
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
      lastError: `Telegram editMessageText failed: ${err.message}`,
    });
    console.error('[TELEGRAM] Edit error:', err.message);
    return null;
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

async function recordDailyReportDelivery(plan, patch = {}) {
  try {
    await financialLedgerRepository.recordTelegramReportDelivery({
      reportDate: plan.reportDate,
      status: patch.status,
      payload: patch.payload ?? plan.text ?? null,
      sentAt: patch.sentAt || null,
      error: patch.error || null,
      metadata: patch.metadata || {},
    });
  } catch (err) {
    console.warn('[TELEGRAM] Daily report ledger write failed:', err.message);
  }
}

// ── Send daily financial summary report ──
async function sendDailySummaryReport(latestData = null, options = {}) {
  const plan = buildDailySummaryReportPlan(
    latestData || {},
    telegramState.getState(),
    options.now || new Date()
  );
  if (!plan.shouldSend || !plan.text) {
    await recordDailyReportDelivery(plan, {
      status: `skipped:${plan.reason}`,
      error: plan.reason,
      metadata: plan.diagnostics ? { diagnostics: plan.diagnostics } : {},
    });
    return { skipped: true, reason: plan.reason, reportDate: plan.reportDate };
  }

  const result = await sendMessage(plan.text);
  const sentAt = new Date().toISOString();
  if (result?.ok) {
    telegramState.markDailyReportSent({
      reportDate: plan.reportDate,
      sentAt: options.sentAt || sentAt,
    });
    await recordDailyReportDelivery(plan, {
      status: 'sent',
      sentAt: options.sentAt || sentAt,
      metadata: {
        telegramMessageId: result.result?.message_id || null,
      },
    });
  } else {
    await recordDailyReportDelivery(plan, {
      status: 'failed',
      error: result?.description || 'telegram-send-failed',
    });
  }
  return result;
}

let statusTimer = null;

function startStatusChecks() {
  const configError = getConfigurationError();
  if (configError) {
    syncStatus({ status: 'misconfigured', lastCheckedAt: nowIso(), lastError: configError });
    console.warn('[TELEGRAM] Status checks not started:', configError);
    return null;
  }
  if (statusTimer) {
    return statusTimer;
  }
  console.log('[TELEGRAM] Starting notification status checks...');
  probeConnection().catch(() => {});
  statusTimer = setInterval(() => {
    probeConnection().catch(() => {});
  }, 60000);
  return statusTimer;
}

function stopStatusChecks() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
    console.log('[TELEGRAM] Notification status checks stopped');
  }
}

module.exports = {
  sendMessage,
  sendPrivateMessage,
  editMessageText,
  sendScanSummary,
  sendDailySummaryReport,
  getStatus,
  getPrivateDeliveryError,
  probeConnection,
  startStatusChecks,
  stopStatusChecks,
};
