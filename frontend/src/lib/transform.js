/**
 * Backend JSON -> Meridian view model.
 *
 * The frontend does no scoring of its own. Everything here is presentation:
 * mapping the backend's risk bands onto Meridian's tier vocabulary, deriving
 * the four Meridian flags from real rule IDs, and shaping the score ledger.
 */

/* ---------- Tier mapping -----------------------------------------------
 * Meridian ships four tiers: Critical / High / Watch / Low.
 * risk-policy.json v2.1.0 ships four bands: CRITICAL / HIGH / MEDIUM / LOW.
 * They line up one-to-one; MEDIUM renders as Meridian's "Watch".
 * ---------------------------------------------------------------------- */
export const TIERS = {
  CRITICAL: { name: "Critical", cls: "t-crit", color: "var(--crit)", order: 0 },
  HIGH: { name: "High", cls: "t-high", color: "var(--high)", order: 1 },
  MEDIUM: { name: "Watch", cls: "t-watch", color: "var(--watch)", order: 2 },
  LOW: { name: "Low", cls: "t-low", color: "var(--low)", order: 3 },
};

export const TIER_FILTERS = ["all", "Critical", "High", "Watch", "Low"];

export function tierOf(riskLevel) {
  return TIERS[String(riskLevel ?? "LOW").toUpperCase()] ?? TIERS.LOW;
}

/* ---------- Recommended actions ---------------------------------------- */
const ACTION_LABELS = {
  HOLD_AND_ESCALATE: "Hold & escalate",
  PRIORITY_REVIEW: "Priority review",
  STANDARD_REVIEW: "Standard review",
  MONITOR: "Monitor",
};

export function actionLabel(action) {
  return ACTION_LABELS[action] ?? String(action ?? "—").replaceAll("_", " ").toLowerCase();
}

/* ---------- Flags ------------------------------------------------------
 * Meridian's four flags, now derived from real rule and override IDs in
 * backend/config/risk-policy.json rather than hardcoded booleans.
 * ---------------------------------------------------------------------- */
const SANCTION_OVERRIDE_IDS = [
  "ENTITY_SANCTIONS_MATCH",
  "BENEFICIAL_OWNER_SANCTIONS_MATCH",
  "SANCTIONED_DESTINATION",
];

export function deriveFlags(assessment) {
  const ruleIds = new Set((assessment.rulesTriggered ?? []).map((r) => r.ruleId));
  const overrideIds = new Set((assessment.hardOverrides ?? []).map((o) => o.ruleId));

  return [
    {
      key: "sanctions",
      label: "Sanctions screening hit",
      on: SANCTION_OVERRIDE_IDS.some((id) => overrideIds.has(id)),
    },
    { key: "pep", label: "PEP linkage", on: ruleIds.has("PEP_EXPOSURE") },
    { key: "adverse", label: "Adverse media", on: ruleIds.has("ADVERSE_MEDIA") },
    { key: "structuring", label: "Structuring pattern", on: ruleIds.has("STRUCTURING_PATTERN") },
  ];
}

/* ---------- Score composition -----------------------------------------
 * Meridian's weighted factor ledger, repointed at the backend's real
 * two-part composition: rule score x ruleWeight + anomaly score x anomalyWeight.
 * ---------------------------------------------------------------------- */
export function scoreComposition(assessment) {
  const b = assessment.scoreBreakdown ?? {};
  const ruleWeight = Number(b.ruleWeight ?? 1);
  const anomalyWeight = Number(b.anomalyWeight ?? 0);
  const ruleScore = Number(b.ruleScore ?? 0);

  const rows = [
    {
      key: "rules",
      name: "Deterministic compliance rules",
      weightLabel: `${Math.round(ruleWeight * 100)}%`,
      sub: ruleScore,
      contrib: +(ruleScore * ruleWeight).toFixed(1),
      available: true,
    },
  ];

  if (b.anomalyAvailable) {
    const anomalyScore = Number(b.anomalyScore ?? 0);
    rows.push({
      key: "anomaly",
      name: "Behavioural anomaly · SAP AI Core",
      weightLabel: `${Math.round(anomalyWeight * 100)}%`,
      sub: anomalyScore,
      contrib: +(anomalyScore * anomalyWeight).toFixed(1),
      available: true,
    });
  } else {
    rows.push({
      key: "anomaly",
      name: "Behavioural anomaly · model unavailable",
      weightLabel: "0%",
      sub: 0,
      contrib: 0,
      available: false,
    });
  }

  return rows.sort((a, z) => z.contrib - a.contrib);
}

/* ---------- Rule ledger ------------------------------------------------ */
const MAX_RULE_POINTS = 30; // highest single-rule award in risk-policy.json v2.1.0

export function ruleLedger(assessment) {
  return [...(assessment.rulesTriggered ?? [])]
    .sort((a, z) => Number(z.points) - Number(a.points))
    .map((rule) => ({
      ...rule,
      points: Number(rule.points),
      barWidth: Math.min(100, (Number(rule.points) / MAX_RULE_POINTS) * 100),
    }));
}

/* ---------- Case facts -------------------------------------------------
 * Meridian's five-fact strip. The live backend does not yet return the
 * transaction detail block (see README), so each fact degrades to a real
 * value the backend *does* return rather than to an empty cell.
 * ---------------------------------------------------------------------- */
const currencyFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatAmount(txn) {
  if (!txn?.amountUsd) return null;
  return `${txn.currency ?? "USD"} ${currencyFormat.format(Number(txn.amountUsd))}`;
}

export function daysOpen(assessment) {
  const initiated = assessment.transaction?.initiatedAt;
  if (!initiated) return null;
  const ms = new Date(assessment.generatedAt ?? Date.now()) - new Date(initiated);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}

export function buildFacts(assessment) {
  const txn = assessment.transaction;
  const open = daysOpen(assessment);

  return [
    {
      label: "Amount",
      value: formatAmount(txn) ?? "Not returned",
      small: false,
      dim: !txn?.amountUsd,
    },
    {
      // ~88% of TEAM_12.TRANSACTIONS are domestic. Labelling that explicitly
      // stops a same-country corridor reading as a broken lookup.
      label: txn?.crossBorder === false ? "Corridor · domestic" : "Corridor",
      value:
        txn?.originatorCountry && txn?.destinationCountry
          ? `${txn.originatorCountry} → ${txn.destinationCountry}`
          : "Not returned",
      small: true,
      dim: !txn?.originatorCountry,
    },
    {
      label: "Client",
      value: txn?.originatorName ?? `TXN ${assessment.transactionId}`,
      small: true,
      dim: !txn?.originatorName,
    },
    {
      label: open === null ? "Prior history" : "Days open",
      value:
        open === null
          ? `${assessment.historyTransactionCount ?? 0} txns`
          : String(open),
      small: false,
      dim: false,
    },
    {
      label: "Recommended",
      value: actionLabel(assessment.assessment?.recommendedAction),
      small: true,
      dim: false,
    },
  ];
}

/* ---------- Feature snapshot ------------------------------------------- */
export const FEATURE_LABELS = {
  amount_ratio: "amount ratio",
  amount_zscore: "amount z-score",
  transaction_count_1h: "count · 1h",
  transaction_count_24h: "count · 24h",
  value_ratio_24h: "value ratio · 24h",
  hours_since_previous: "hours since previous",
  is_new_counterparty: "new counterparty",
  is_new_country: "new country",
  is_unusual_time: "unusual time",
};

export const BINARY_FEATURES = new Set([
  "is_new_counterparty",
  "is_new_country",
  "is_unusual_time",
]);

export function featureCells(snapshot) {
  if (!snapshot) return [];
  return Object.keys(FEATURE_LABELS).map((key) => {
    const raw = snapshot[key];
    const binary = BINARY_FEATURES.has(key);
    return {
      key,
      label: FEATURE_LABELS[key],
      value: binary ? (Number(raw) === 1 ? "yes" : "no") : Number(raw ?? 0).toFixed(2),
      state: binary ? (Number(raw) === 1 ? "on" : "off") : null,
    };
  });
}

/* ---------- Identity ---------------------------------------------------
 * Assessments persisted by assessment-store.js carry a UUID; ones fetched
 * directly from /from-transaction do not. Prefer the stable ID when present.
 * ---------------------------------------------------------------------- */
export function alertKey(assessment) {
  return assessment?.assessmentId ?? assessment?.alertId ?? assessment?.transactionId ?? null;
}

/** Case number assigned by HANA on persistence, e.g. CASE-000117. */
export function caseLabel(assessment) {
  if (assessment?.caseId == null) return null;
  return `CASE-${String(assessment.caseId).padStart(6, "0")}`;
}

/* ---------- Triage eligibility -----------------------------------------
 * An assessment that scored 0 triggered no rule and carried no anomaly
 * contribution, so there is nothing for an analyst to act on. It stays in
 * RISK_ASSESSMENTS as a record that the transaction was examined and cleared,
 * but it does not belong in a queue ranked by exposure.
 * ---------------------------------------------------------------------- */
export const MIN_TRIAGE_SCORE = 1;

export function isTriageable(assessment) {
  return Number(assessment?.assessment?.overallScore ?? 0) >= MIN_TRIAGE_SCORE;
}

/* ---------- Sorting / filtering ---------------------------------------- */
export function sortByExposure(alerts) {
  return [...alerts].sort((a, z) => {
    const diff = Number(z.assessment?.overallScore ?? 0) - Number(a.assessment?.overallScore ?? 0);
    if (diff !== 0) return diff;
    // Tie-break: hard overrides first, they are the non-negotiable ones.
    return Number(z.assessment?.hardOverride ?? false) - Number(a.assessment?.hardOverride ?? false);
  });
}

export function filterByTier(alerts, filter) {
  if (filter === "all") return alerts;
  return alerts.filter((a) => tierOf(a.assessment?.riskLevel).name === filter);
}

export function formatTimestamp(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
