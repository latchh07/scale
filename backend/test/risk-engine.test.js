import assert from "node:assert/strict";
import test from "node:test";

import { calculateAssessment, loadPolicy } from "../src/risk-engine.js";

const policy = await loadPolicy();

function assess(overrides = {}) {
  return calculateAssessment({
    alertId: "ALT-TEST",
    transactionId: "TX-TEST",
    ruleInputs: {},
    anomalyResult: { anomalyScore: 0, modelVersion: "test-v1" },
    policy,
    generatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  });
}

test("normal transaction produces a low score", () => {
  const result = assess();
  assert.equal(result.assessment.overallScore, 0);
  assert.equal(result.assessment.riskLevel, "LOW");
});

test("configured weights combine rule and anomaly scores", () => {
  const result = assess({
    ruleInputs: {
      isHighRiskCountry: true,
      isNewCounterparty: true,
      amountRatio: 5,
      transactionCount1h: 10,
      isUnusualTime: true,
      isRapidMovement: true,
    },
    anomalyResult: { anomalyScore: 100, modelVersion: "test-v1" },
  });

  // Rule points reach the policy cap of 100, then 75/25 weighting remains 100.
  assert.equal(result.scoreBreakdown.ruleScore, 100);
  assert.equal(result.assessment.overallScore, 100);
  assert.equal(result.assessment.riskLevel, "CRITICAL");
});

test("exclusive amount rules do not double count", () => {
  const result = assess({
    ruleInputs: { amountRatio: 5 },
  });
  assert.equal(result.scoreBreakdown.ruleScore, 30);
  assert.equal(result.rulesTriggered.length, 1);
  assert.equal(result.rulesTriggered[0].ruleId, "EXTREME_AMOUNT_DEVIATION");
});

test("sanctions match overrides the weighted score", () => {
  const result = assess({
    ruleInputs: { sanctionsMatch: true },
    anomalyResult: { anomalyScore: 0, modelVersion: "test-v1" },
  });
  assert.equal(result.assessment.overallScore, 100);
  assert.equal(result.assessment.hardOverride, true);
});

test("missing model falls back to the rule score", () => {
  const result = assess({
    ruleInputs: { isHighRiskCountry: true, isNewCounterparty: true },
    anomalyResult: null,
  });
  assert.equal(result.scoreBreakdown.ruleScore, 35);
  assert.equal(result.assessment.overallScore, 35);
  assert.equal(result.scoreBreakdown.ruleWeight, 1);
  assert.equal(result.modelSignals.status, "MODEL_UNAVAILABLE");
});

