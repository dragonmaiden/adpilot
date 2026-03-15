const Sentry = require('@sentry/node');
const config = require('../config');
const observabilityStore = require('../modules/observabilityStore');

const serviceState = {
  initialized: false,
  enabled: false,
  serviceName: null,
  lastEventAt: null,
  lastError: null,
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeTags(tags) {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
    return {};
  }

  return Object.entries(tags).reduce((result, [key, value]) => {
    result[String(key)] = String(value);
    return result;
  }, {});
}

function initObservability(serviceName = 'adpilot-server') {
  if (serviceState.initialized) {
    return getStatus();
  }

  serviceState.initialized = true;
  serviceState.serviceName = serviceName;
  const dsn = String(config.sentry?.dsn || '').trim();

  if (!dsn) {
    serviceState.enabled = false;
    serviceState.lastError = null;
    return getStatus();
  }

  try {
    Sentry.init({
      dsn,
      environment: config.sentry.environment,
      release: config.sentry.release,
      tracesSampleRate: 0,
    });
    serviceState.enabled = true;
    serviceState.lastError = null;
  } catch (err) {
    serviceState.enabled = false;
    serviceState.lastError = err.message;
    console.warn(`[OBSERVABILITY] Failed to initialize Sentry: ${err.message}`);
  }

  return getStatus();
}

function getStatus() {
  return {
    initialized: serviceState.initialized,
    enabled: serviceState.enabled,
    serviceName: serviceState.serviceName,
    dsnConfigured: Boolean(String(config.sentry?.dsn || '').trim()),
    environment: config.sentry?.environment || 'development',
    lastEventAt: serviceState.lastEventAt,
    lastError: serviceState.lastError,
  };
}

function persistLocalEvent({
  level = 'info',
  category = 'general',
  title = '',
  message = '',
  tags = {},
  data = null,
  source = null,
  sentryStatus = 'skipped',
}) {
  const event = {
    id: `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowIso(),
    level,
    category,
    title,
    message,
    tags: normalizeTags(tags),
    data,
    source: source || serviceState.serviceName || 'unknown',
    sentryStatus,
  };

  observabilityStore.addObservabilityEvent(event);
  serviceState.lastEventAt = event.timestamp;
  return event;
}

function addBreadcrumb({ category = 'general', message = '', level = 'info', data = null }) {
  if (!serviceState.enabled) return;

  try {
    Sentry.addBreadcrumb({
      category,
      message,
      level,
      data,
      timestamp: Date.now() / 1000,
    });
  } catch (err) {
    serviceState.lastError = err.message;
  }
}

function captureMessage(message, level = 'info', context = {}) {
  const { category = 'general', title = message, tags = {}, data = null, source = null } = context;
  let sentryStatus = 'skipped';

  if (serviceState.enabled) {
    try {
      Sentry.withScope(scope => {
        Object.entries(normalizeTags(tags)).forEach(([key, value]) => scope.setTag(key, value));
        if (data) scope.setContext(category, data);
        scope.setLevel(level);
        Sentry.captureMessage(message);
      });
      sentryStatus = 'captured';
    } catch (err) {
      sentryStatus = 'failed';
      serviceState.lastError = err.message;
    }
  }

  return persistLocalEvent({
    level,
    category,
    title,
    message,
    tags,
    data,
    source,
    sentryStatus,
  });
}

function captureException(err, context = {}) {
  const error = err instanceof Error ? err : new Error(String(err || 'Unknown error'));
  const {
    category = 'exception',
    title = error.name || 'Error',
    tags = {},
    data = null,
    source = null,
    level = 'error',
  } = context;

  let sentryStatus = 'skipped';
  if (serviceState.enabled) {
    try {
      Sentry.withScope(scope => {
        Object.entries(normalizeTags(tags)).forEach(([key, value]) => scope.setTag(key, value));
        if (data) scope.setContext(category, data);
        Sentry.captureException(error);
      });
      sentryStatus = 'captured';
    } catch (captureErr) {
      sentryStatus = 'failed';
      serviceState.lastError = captureErr.message;
    }
  }

  return persistLocalEvent({
    level,
    category,
    title,
    message: error.message,
    tags,
    data: {
      ...(data || {}),
      stack: error.stack || null,
    },
    source,
    sentryStatus,
  });
}

module.exports = {
  initObservability,
  getStatus,
  addBreadcrumb,
  captureMessage,
  captureException,
};
