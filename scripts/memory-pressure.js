const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonFileSync, measureJsonBytes } = require('../server/runtime/jsonFile');
const mode = process.argv[2];
if (!['old', 'new'].includes(mode)) throw new Error('Usage: node scripts/memory-pressure.js old|new');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adpilot-memory-probe-'));
const filepath = path.join(dir, 'latest_data.json');
// Synthetic vendor records and overlapping canonical/derived collections.
// This is a pressure fixture, not a copy or estimate of live financial data.
const rows = Array.from({ length: 30000 }, (_, id) => ({
  orderNo: `order-${id}`, approved: 100, refunded: id % 10 === 0 ? 40 : 0,
  customer: 'synthetic', payload: 'x'.repeat(1024),
}));
const data = { orders: rows, cogsData: { items: rows }, economicsLedger: { rows }, fx: { usdToKrwRate: 1400 } };
// Represent the resident non-serialization workload observed in production.
const resident = Buffer.alloc(160 * 1024 * 1024, 1);
const before = process.memoryUsage();
const start = performance.now();
try {
  for (let pass = 0; pass < 8; pass++) {
    if (mode === 'old') fs.writeFileSync(filepath, JSON.stringify(data, null, 2), { mode: 0o600 });
    else writeJsonFileSync(filepath, data);
  }
  const result = {
    mode, records: rows.length, passes: 8, residentBytes: resident.length,
    fileBytes: fs.statSync(filepath).size,
    compactJsonBytes: measureJsonBytes(data),
    before, after: process.memoryUsage(),
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    durationMs: Math.round(performance.now() - start),
    residentCheck: resident[resident.length - 1],
  };
  console.log(JSON.stringify(result));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
