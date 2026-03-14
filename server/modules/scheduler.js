const scanRunner = require('./scanRunner');
const scanStore = require('./scanStore');
const schedulerLoop = require('./schedulerLoop');
const snapshotRepository = require('./snapshotRepository');

function startScheduler() {
  return schedulerLoop.startScheduler(scanRunner.runScan, scanRunner.runCommerceSync);
}

module.exports = {
  runScan: scanRunner.runScan,
  runCommerceSync: scanRunner.runCommerceSync,
  startScheduler,
  stopScheduler: schedulerLoop.stopScheduler,
  getNextScheduledRunAt: schedulerLoop.getNextScheduledRunAt,
  getLatestData: scanStore.getLatestData,
  getSourceHealth: scanStore.getSourceHealth,
  getLastScanResult: scanStore.getLastScanResult,
  getLastScanTime: scanStore.getLastScanTime,
  getScanHistory: scanStore.getScanHistory,
  getAllOptimizations: scanStore.getAllOptimizations,
  updateOptimization: scanStore.updateOptimization,
  getIsScanning: scanStore.getIsScanning,
  getSnapshotsList: snapshotRepository.getSnapshotsList,
  getSnapshot: snapshotRepository.getSnapshot,
};
