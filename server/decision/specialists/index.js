const evaluateControlSurface = require('./controlSurfaceGuard');
const evaluateEconomics = require('./economicsGuard');
const evaluateConfidence = require('./confidenceGuard');
const evaluateFatigue = require('./fatigueGuard');
const evaluateStructure = require('./structureGuard');
const evaluateTrend = require('./trendGuard');
const evaluateScaleSizer = require('./scaleSizer');
const evaluateReduceSizer = require('./reduceSizer');

function evaluateSpecialists(context) {
  return [
    evaluateControlSurface(context),
    evaluateEconomics(context),
    evaluateConfidence(context),
    evaluateFatigue(context),
    evaluateStructure(context),
    evaluateTrend(context),
    evaluateScaleSizer(context),
    evaluateReduceSizer(context),
  ];
}

module.exports = {
  evaluateSpecialists,
};
