// ═══════════════════════════════════════════════════════
// AdPilot — Configuration
// All secrets via environment variables (required on Render)
// ═══════════════════════════════════════════════════════

const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (err) {
  // Local test/worktree environments may not install dotenv, and production
  // already provides real env vars. Missing dotenv should not block startup.
  if (err?.code !== 'MODULE_NOT_FOUND') {
    throw err;
  }
}

function deepFreeze(obj) {
  Object.freeze(obj);

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return obj;
}

const config = {
  // Meta Ads API
  meta: {
    accessToken: process.env.META_ACCESS_TOKEN,
    adAccountId: process.env.META_AD_ACCOUNT_ID || 'act_1407071387528879',
    businessId: process.env.META_BUSINESS_ID || '1037680327881084',
    apiVersion: 'v20.0',
    baseUrl: 'https://graph.facebook.com',
  },

  // Imweb API
  imweb: {
    clientId: process.env.IMWEB_CLIENT_ID,
    clientSecret: process.env.IMWEB_CLIENT_SECRET,
    siteCode: process.env.IMWEB_SITE_CODE || 'S20260108741f7ad4afc71',
    unitCode: process.env.IMWEB_UNIT_CODE || 'u20260108695f4cab3dea1',
    baseUrl: 'https://openapi.imweb.me',
  },

  // Optimization Rules
  rules: {
    maxBudgetChangePercent: 20,
    cpaPauseThreshold: 50,
    cpaWarningThreshold: 30,
    minSpendForDecision: 20,
    fatigueFrequencyThreshold: 4,
    fatigueCtrDecayPercent: 30,
    roasMinimum: 1.5,
    minDataDays: 3,
    budgetReallocationEnabled: true,
  },

  // Scheduler
  scheduler: {
    scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || '10', 10),
    dataRetentionDays: 90,
  },

  // Business history
  business: {
    startDate: process.env.BUSINESS_START_DATE || '2026-02-01',
  },

  // COGS (Google Sheets)
  cogs: {
    spreadsheetId: process.env.COGS_SPREADSHEET_ID || '1oTPHDukiO6zTuYW5Q7-hhCupFPDuR2aEGRAAdzjTslY',
    sheetGids: {
      '2월': process.env.COGS_GID_FEB || '0',
      '3월': process.env.COGS_GID_MAR || '456791124',
      '4월': process.env.COGS_GID_APR || '1048499191',
    },
    autofill: {
      googleClientEmail: process.env.COGS_GOOGLE_CLIENT_EMAIL || '',
      googlePrivateKey: process.env.COGS_GOOGLE_PRIVATE_KEY || '',
    },
  },

  // Card settlement reconciliation (Google Sheets)
  cardSettlement: {
    spreadsheetId: process.env.CARD_SETTLEMENT_SPREADSHEET_ID || '18JgdneWqL0ickJ7ieNN5Mhe3ErHVQrXw1-643S8scco',
    gid: process.env.CARD_SETTLEMENT_GID || '0',
    merchantName: process.env.CARD_SETTLEMENT_MERCHANT || 'SHUE',
    matchWindowMinutes: parseInt(process.env.CARD_SETTLEMENT_MATCH_WINDOW_MINUTES || '3', 10),
  },

  // Fees
  fees: {
    paymentFeeRate: 0.06, // Standard payment fee assumption (6%)
  },

  // Currency
  currency: {
    usdToKrw: 1450,
    storeCurrency: 'KRW',
  },

  // Telegram notifications
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    privateChatId: process.env.TELEGRAM_PRIVATE_CHAT_ID,
    requestTimeoutMs: parseInt(process.env.TELEGRAM_REQUEST_TIMEOUT_MS || '10000', 10),
  },

  // Observability
  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || process.env.npm_package_version || 'local',
  },

  features: {
    legacyAdOpsEnabled: process.env.LEGACY_AD_OPS_ENABLED === 'true',
  },

  // Server
  server: {
    port: parseInt(process.env.PORT || '3001', 10),
  },

  // Paths
  paths: {
    defaultDataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  },
};

module.exports = deepFreeze(config);
