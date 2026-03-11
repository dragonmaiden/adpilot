const scanRunner = require('./scanRunner');
const scanStore = require('./scanStore');
const schedulerLoop = require('./schedulerLoop');
const snapshotRepository = require('./snapshotRepository');

function startScheduler() {
  return schedulerLoop.startScheduler(scanRunner.runScan);
}

module.exports = {
  runScan: scanRunner.runScan,
  startScheduler,
  stopScheduler: schedulerLoop.stopScheduler,
  getNextScheduledRunAt: schedulerLoop.getNextScheduledRunAt,
  getLatestData: scanStore.getLatestData,
  getSourceHealth: scanStore.getSourceHealth,
  getLastScanResult: scanStore.getLastScanResult,
  getLastScanTime: scanStore.getLastScanTime,
  getScanHistory: scanStore.getScanHistory,
  getAllOptimizations: scanStore.getAllOptimizations,
  getIsScanning: scanStore.getIsScanning,
  getSnapshotsList: snapshotRepository.getSnapshotsList,
  getSnapshot: snapshotRepository.getSnapshot,
};
