const runtimeSettings = require('../runtime/runtimeSettings');
const policyLabService = require('../services/policyLabService');
const observabilityService = require('../services/observabilityService');

async function main() {
  const rules = runtimeSettings.getRules();
  observabilityService.initObservability('adpilot-policy-lab');
  policyLabService.ensureInitialized(rules);

  const result = policyLabService.runResearchIteration(rules);
  const bestImprovementRatio = Number(result.bestPolicy?.scoreSummary?.improvementRatio || 0);

  console.log('[POLICY LAB] Research iteration complete');
  console.log(`[POLICY LAB] Replay sample size: ${result.replaySampleSize}`);
  console.log(`[POLICY LAB] Challenger count: ${result.experiments.length}`);
  if (result.bestPolicy) {
    console.log(`[POLICY LAB] Best policy: ${result.bestPolicy.id} (${(bestImprovementRatio * 100).toFixed(1)}% improvement)`);
  } else {
    console.log('[POLICY LAB] No promotion-ready challenger this run');
  }
}

main().catch(err => {
  observabilityService.captureException(err, {
    category: 'policy_lab.worker',
    title: 'Policy lab worker failed',
  });
  console.error('[POLICY LAB] Worker failed:', err);
  process.exitCode = 1;
});
