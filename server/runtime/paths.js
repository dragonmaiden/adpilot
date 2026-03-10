const fs = require('fs');
const path = require('path');
const config = require('../config');

function ensureWritableDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const testFile = path.join(dir, '.write-test');
  fs.writeFileSync(testFile, 'ok');
  fs.unlinkSync(testFile);
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
