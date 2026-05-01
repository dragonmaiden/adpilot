const { Pool } = require('pg');

let pool = null;

function getDatabaseUrl() {
  return typeof process.env.DATABASE_URL === 'string'
    ? process.env.DATABASE_URL.trim()
    : '';
}

function isConfigured() {
  return getDatabaseUrl().length > 0;
}

function shouldUseSsl(connectionString) {
  try {
    const url = new URL(connectionString);
    const hostname = url.hostname.toLowerCase();
    if (url.searchParams.get('sslmode') === 'disable') return false;
    return hostname !== 'localhost' && hostname !== '127.0.0.1';
  } catch (_) {
    return true;
  }
}

function getPool() {
  const connectionString = getDatabaseUrl();
  if (!connectionString) return null;

  if (!pool) {
    pool = new Pool({
      connectionString,
      ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
    });
  }

  return pool;
}

async function withClient(callback) {
  const activePool = getPool();
  if (!activePool) {
    return { skipped: true, reason: 'database-url-missing' };
  }

  const client = await activePool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function query(text, params = []) {
  const activePool = getPool();
  if (!activePool) {
    return { skipped: true, reason: 'database-url-missing' };
  }
  return activePool.query(text, params);
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  closePool,
  isConfigured,
  query,
  withClient,
};
