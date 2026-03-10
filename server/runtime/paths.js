const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureWritableDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const testFile = path.join(
    dir,
    `.write-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  fs.writeFileSync(testFile, 'ok', { flag: 'wx' });

  try {
    fs.unlinkSync(testFile);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

const configuredDataDir = config.paths.defaultDataDir;
const fallbackDataDir = path.join(__dirname, '..', 'data');

let dataDir = configuredDataDir;
let usedFallback = false;
let fallbackReason = null;

try {
  ensureWritableDirectory(configuredDataDir);
} catch (err) {
  usedFallback = configuredDataDir !== fallbackDataDir;
  fallbackReason = err;
  dataDir = fallbackDataDir;
  ensureWritableDirectory(dataDir);
}

const logDir = path.join(dataDir, 'logs');
ensureWritableDirectory(logDir);

module.exports = {
  configuredDataDir,
  fallbackDataDir,
  dataDir,
  logDir,
  imwebTokenFile: path.join(dataDir, 'imweb_tokens.json'),
  runtimeSettingsFile: path.join(dataDir, 'runtime_settings.json'),
  usedFallback,
  fallbackReason,
};
