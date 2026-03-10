// ═══════════════════════════════════════════════════════
// AdPilot — Configuration
// All secrets via environment variables (required on Render)
// ═══════════════════════════════════════════════════════

const path = require('path');

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
    autonomousMode: true,
  },

  // Scheduler
  scheduler: {
    scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || '60', 10),
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
