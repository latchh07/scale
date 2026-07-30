import { readFile } from "node:fs/promises";

const DEFAULT_POLICY_URL = new URL("../config/risk-policy.json", import.meta.url);

export async function loadPolicy(policyUrl = DEFAULT_POLICY_URL) {
  const raw = await readFile(policyUrl, "utf8");
  const policy = JSON.parse(raw);
  validatePolicy(policy);
  return policy;
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") {
    throw new Error("Risk policy must be an object");
  }

  const ruleWeight = Number(policy.weights?.rules);
  const anomalyWeight = Number(policy.weights?.anomaly);
  if (
    !Number.isFinite(ruleWeight) ||
    !Number.isFinite(anomalyWeight) ||
    Math.abs(ruleWeight + anomalyWeight - 1) > 0.000001
  ) {
    throw new Error("Risk policy weights must be numeric and add up to 1");
  }

  if (!Array.isArray(policy.rules) || !Array.isArray(policy.riskBands)) {
    throw new Error("Risk policy requires rules and riskBands arrays");
  }

  if (policy.riskBands.length === 0) {
    throw new Error("Risk policy must define at least one risk band");
  }
}

function compare(actual, operator, expected) {
  switch (operator) {
    case "eq":
      return actual === expected;
    case "gte":
      return Number(actual) >= Number(expected);
    case "gt":
      return Number(actual) > Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    default:
      throw new Error(`Unsupported rule operator: ${operator}`);
  }
}

function triggeredItems(definitions, ruleInputs) {
  return definitions.filter((definition) =>
    compare(
      ruleInputs[definition.field],
      definition.operator,
      definition.value,
    ),
  );
}

function selectExclusiveRules(triggeredRules) {
  const selected = [];
  const groups = new Map();

  for (const rule of triggeredRules) {
    if (!rule.exclusiveGroup) {
      selected.push(rule);
      continue;
    }

    const current = groups.get(rule.exclusiveGroup);
    if (!current || Number(rule.points) > Number(current.points)) {
      groups.set(rule.exclusiveGroup, rule);
    }
  }

  return selected.concat([...groups.values()]);
}

function clampScore(value, cap = 100) {
  return Math.max(0, Math.min(cap, Math.round(Number(value))));
}

function bandForScore(score, riskBands) {
  const sorted = [...riskBands].sort(
    (left, right) => Number(right.minimum) - Number(left.minimum),
  );
  return sorted.find((band) => score >= Number(band.minimum)) ?? sorted.at(-1);
}

export function calculateAssessment({
  alertId,
  transactionId,
  ruleInputs = {},
  anomalyResult,
  policy,
  generatedAt = new Date().toISOString(),
}) {
  validatePolicy(policy);

  const rules = selectExclusiveRules(triggeredItems(policy.rules, ruleInputs));
  const ruleScore = clampScore(
    rules.reduce((total, rule) => total + Number(rule.points), 0),
    policy.scoreCap,
  );

  const overrides = triggeredItems(policy.hardOverrides ?? [], ruleInputs);
  const overrideScore = overrides.reduce(
    (maximum, override) =>
      Math.max(maximum, Number(override.minimumScore ?? 0)),
    0,
  );

  const anomalyAvailable =
    anomalyResult &&
    Number.isFinite(Number(anomalyResult.anomalyScore));
  const anomalyScore = anomalyAvailable
    ? clampScore(anomalyResult.anomalyScore, policy.scoreCap)
    : null;

  const weightedScore = anomalyAvailable
    ? ruleScore * Number(policy.weights.rules) +
      anomalyScore * Number(policy.weights.anomaly)
    : ruleScore;
  const overallScore = clampScore(
    Math.max(weightedScore, overrideScore),
    policy.scoreCap,
  );
  const band = bandForScore(overallScore, policy.riskBands);

  return {
    alertId,
    transactionId,
    assessment: {
      overallScore,
      riskLevel: band.level,
      recommendedAction: band.recommendedAction,
      hardOverride: overrides.length > 0,
    },
    scoreBreakdown: {
      ruleScore,
      anomalyScore,
      ruleWeight: anomalyAvailable ? Number(policy.weights.rules) : 1,
      anomalyWeight: anomalyAvailable ? Number(policy.weights.anomaly) : 0,
      anomalyAvailable: Boolean(anomalyAvailable),
    },
    rulesTriggered: rules.map((rule) => ({
      ruleId: rule.id,
      description: rule.description,
      points: Number(rule.points),
    })),
    hardOverrides: overrides.map((override) => ({
      ruleId: override.id,
      description: override.description,
      minimumScore: Number(override.minimumScore),
    })),
    modelSignals: anomalyAvailable
      ? {
          modelVersion: anomalyResult.modelVersion ?? "unknown",
          anomalyFlag:
            anomalyResult.anomalyFlag ??
            anomalyScore >= Number(policy.anomalyFlagThreshold ?? 85),
          anomalyBand: anomalyResult.anomalyBand ?? null,
          topDeviations: anomalyResult.topDeviations ?? [],
        }
      : {
          modelVersion: null,
          anomalyFlag: null,
          anomalyBand: null,
          topDeviations: [],
          status: "MODEL_UNAVAILABLE",
        },
    policyVersion: policy.policyVersion,
    generatedAt,
  };
}
