const fs = require('node:fs');

const CHUNK_CHARS = 64 * 1024;

// Persist JSON data without allocating a string and UTF-8 buffer for the entire
// scan. Memory is bounded by the chunk size plus the largest scalar and keys list.
function* jsonTokens(value, key = '', ancestors = new Set()) {
  if (value && typeof value.toJSON === 'function') value = value.toJSON(key);
  if (value instanceof Number || value instanceof String || value instanceof Boolean || value instanceof BigInt) {
    value = value.valueOf();
  }
  if (value === null || typeof value !== 'object') {
    yield JSON.stringify(value);
    return;
  }
  if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield '[';
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        if (index) yield ',';
        let first = true;
        for (const token of jsonTokens(value[index], String(index), ancestors)) {
          yield first && token === undefined ? 'null' : token;
          first = false;
        }
      }
      yield ']';
    } else {
      yield '{';
      let comma = false;
      for (const property of Object.keys(value)) {
        const tokens = jsonTokens(value[property], property, ancestors);
        const first = tokens.next().value;
        if (first === undefined) continue;
        if (comma) yield ',';
        yield JSON.stringify(property);
        yield ':';
        yield first;
        yield* tokens;
        comma = true;
      }
      yield '}';
    }
  } finally {
    ancestors.delete(value);
  }
}

function* jsonChunks(data) {
  let pending = '';
  for (const token of jsonTokens(data)) {
    if (token === undefined) throw new TypeError('Root value is not JSON serializable');
    pending += token;
    while (pending.length >= CHUNK_CHARS) {
      // Keep UTF-16 surrogate pairs together when encoding each chunk as UTF-8.
      const lastCode = pending.charCodeAt(CHUNK_CHARS - 1);
      const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? CHUNK_CHARS - 1 : CHUNK_CHARS;
      yield pending.slice(0, end);
      pending = pending.slice(end);
    }
  }
  if (pending) yield pending;
}

function measureJsonBytes(data) {
  let bytes = 0;
  for (const chunk of jsonChunks(data)) bytes += Buffer.byteLength(chunk);
  return bytes;
}

function writeJsonFileSync(filepath, data) {
  const temporaryPath = `${filepath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx', 0o600);
    for (const chunk of jsonChunks(data)) {
      const buffer = Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length) {
        const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
        if (written === 0) throw new Error('JSON file write made no progress');
        offset += written;
      }
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // An interrupted or failed write must leave the previous recovery copy intact.
    fs.renameSync(temporaryPath, filepath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

module.exports = { writeJsonFileSync, measureJsonBytes };
