import assert from "node:assert/strict";
import test from "node:test";

import { buildModelFeatures } from "../src/hana-context.js";
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
      destinationFatfStatus: "BLACK_LIST",
      pepExposure: true,
      adverseMedia: true,
      newCounterpartyLargeAmount: true,
      amountRatio: 10,
    },
    anomalyResult: { anomalyScore: 100, modelVersion: "test-v1" },
  });

  // Rule points reach the policy cap of 100, then 80/20 weighting remains 100.
  assert.equal(result.scoreBreakdown.ruleScore, 100);
  assert.equal(result.assessment.overallScore, 100);
  assert.equal(result.assessment.riskLevel, "CRITICAL");
});

test("exclusive amount rules do not double count", () => {
  const result = assess({
    ruleInputs: { amountRatio: 10 },
  });
  assert.equal(result.scoreBreakdown.ruleScore, 30);
  assert.equal(result.rulesTriggered.length, 1);
  assert.equal(result.rulesTriggered[0].ruleId, "EXTREME_AMOUNT_DEVIATION");
});

test("new counterparty contributes only when paired with a large amount", () => {
  const ordinary = assess({ ruleInputs: { isNewCounterparty: true } });
  const elevated = assess({ ruleInputs: { newCounterpartyLargeAmount: true } });

  assert.equal(ordinary.scoreBreakdown.ruleScore, 0);
  assert.equal(elevated.scoreBreakdown.ruleScore, 10);
  assert.equal(elevated.rulesTriggered[0].ruleId, "NEW_COUNTERPARTY_LARGE_PAYMENT");
});

test("daily value tiers select only the highest calibrated rule", () => {
  const result = assess({ ruleInputs: { valueRatio24h: 50 } });
  assert.equal(result.scoreBreakdown.ruleScore, 25);
  assert.equal(result.rulesTriggered.length, 1);
  assert.equal(result.rulesTriggered[0].ruleId, "EXTREME_DAILY_VALUE");
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
    ruleInputs: {
      destinationFatfStatus: "GREY_LIST",
      newCounterpartyLargeAmount: true,
    },
    anomalyResult: null,
  });
  assert.equal(result.scoreBreakdown.ruleScore, 25);
  assert.equal(result.assessment.overallScore, 25);
  assert.equal(result.scoreBreakdown.ruleWeight, 1);
  assert.equal(result.modelSignals.status, "MODEL_UNAVAILABLE");
});

test("feature builder uses only earlier history from the same company", () => {
  const transaction = {
    transactionId: "TX-CURRENT",
    beneficiaryCompanyId: "BEN-NEW",
    destinationCountryId: "COUNTRY-NEW",
    amountUsd: 600,
    initiatedAt: "2026-01-02T03:00:00.000Z",
  };
  const history = [
    {
      beneficiaryCompanyId: "BEN-OLD",
      destinationCountryId: "COUNTRY-OLD",
      amountUsd: 100,
      initiatedAt: "2026-01-01T02:59:00.000Z",
    },
    {
      beneficiaryCompanyId: "BEN-OLD",
      destinationCountryId: "COUNTRY-OLD",
      amountUsd: 200,
      initiatedAt: "2026-01-02T02:30:00.000Z",
    },
  ];

  const features = buildModelFeatures(transaction, history);
  assert.equal(features.transaction_id, "TX-CURRENT");
  assert.equal(features.amount_ratio, 4);
  assert.equal(features.transaction_count_1h, 1);
  assert.equal(features.transaction_count_24h, 1);
  assert.equal(features.is_new_counterparty, 1);
  assert.equal(features.is_new_country, 1);
  assert.equal(features.is_unusual_time, 1);
});
