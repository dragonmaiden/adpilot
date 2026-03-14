// ═══════════════════════════════════════════════════════
// AdPilot — Configuration
// All secrets via environment variables (required on Render)
// ═══════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function deepFreeze(obj) {
  Object.freeze(obj);

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }

  return obj;
}

function parseJsonEnv(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) return fallback;

  try {
    return JSON.parse(value);
  } catch (err) {
    console.warn(`[CONFIG] Failed to parse JSON env value: ${err.message}`);
    return fallback;
  }
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
    appBaseUrl: process.env.IMWEB_APP_BASE_URL || '',
    serviceUrl: process.env.IMWEB_APP_SERVICE_URL || '',
    redirectUri: process.env.IMWEB_APP_REDIRECT_URI || '',
    installScope: process.env.IMWEB_APP_SCOPE || 'site-info:read site-info:write order:read',
    integrationConfig: parseJsonEnv(process.env.IMWEB_APP_CONFIG_JSON, null),
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
    autonomousMode: true,
  },

  // Scheduler
  scheduler: {
    scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || '5', 10),
    analysisIntervalMinutes: parseInt(process.env.ANALYSIS_INTERVAL_MINUTES || '30', 10),
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
    },
    autofill: {
      googleClientEmail: process.env.COGS_GOOGLE_CLIENT_EMAIL || '',
      googlePrivateKey: process.env.COGS_GOOGLE_PRIVATE_KEY || '',
      webhookToken: process.env.IMWEB_WEBHOOK_TOKEN || '',
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
    paymentFeeRate: 0.033, // Standard Korean PG rate (3.3%)
  },

  // Currency
  currency: {
    usdToKrw: 1450,
    storeCurrency: 'KRW',
  },

  // Telegram Approval
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },

  // Observability
  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || process.env.npm_package_version || 'local',
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
