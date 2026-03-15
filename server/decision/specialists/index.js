const evaluateMeasurementTrust = require('./measurementTrustGuard');
const evaluateEconomics = require('./economicsGuard');
const evaluateConfidence = require('./confidenceGuard');
const evaluateFatigue = require('./fatigueGuard');
const evaluateStructure = require('./structureGuard');
const evaluateScaleSizer = require('./scaleSizer');
const evaluateReduceSizer = require('./reduceSizer');

function evaluateSpecialists(context) {
  return [
    evaluateMeasurementTrust(context),
    evaluateEconomics(context),
    evaluateConfidence(context),
    evaluateFatigue(context),
    evaluateStructure(context),
    evaluateScaleSizer(context),
    evaluateReduceSizer(context),
  ];
}

module.exports = {
  evaluateSpecialists,
};
