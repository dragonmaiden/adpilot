const crypto = require('crypto');
const config = require('../config');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SHEETS_API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

let googleAccessToken = null;
let googleAccessTokenExpiry = 0;

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizePrivateKey(value) {
  return asString(value).replace(/\\n/g, '\n');
}

function isConfigured() {
  return Boolean(
    asString(config.cogs.autofill.googleClientEmail)
    && normalizePrivateKey(config.cogs.autofill.googlePrivateKey)
  );
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createAssertion() {
  const clientEmail = asString(config.cogs.autofill.googleClientEmail);
  const privateKey = normalizePrivateKey(config.cogs.autofill.googlePrivateKey);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(privateKey);
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function getAccessToken() {
  if (!isConfigured()) {
    throw new Error('Google Sheets service account is not configured');
  }

  if (googleAccessToken && Date.now() < googleAccessTokenExpiry - 60_000) {
    return googleAccessToken;
  }

  const assertion = createAssertion();
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const payload = await response.json();
  if (!response.ok || !payload?.access_token) {
    throw new Error(`Google token request failed: ${payload?.error_description || payload?.error || response.status}`);
  }

  googleAccessToken = payload.access_token;
  googleAccessTokenExpiry = Date.now() + (Number(payload.expires_in || 3600) * 1000);
  return googleAccessToken;
}

async function fetchSpreadsheetMetadata(spreadsheetId) {
  const token = await getAccessToken();
  const response = await fetch(
    `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}?fields=sheets(properties(sheetId,title))`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Google Sheets metadata request failed: ${payload?.error?.message || response.status}`);
  }
  return payload;
}

async function fetchSheetValues(spreadsheetId, sheetName, range = 'A:Q') {
  const token = await getAccessToken();
  const escapedSheetName = String(sheetName || '').replace(/'/g, "''");
  const targetRange = encodeURIComponent(`'${escapedSheetName}'!${range}`);
  const response = await fetch(
    `${SHEETS_API_BASE}/${encodeURIComponent(spreadsheetId)}/values/${targetRange}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Google Sheets values request failed: ${payload?.error?.message || response.status}`);
  }
  return Array.isArray(payload?.values) ? payload.values : [];
}

module.exports = {
  isConfigured,
  fetchSpreadsheetMetadata,
  fetchSheetValues,
};
