/**
 * Assistant content synthesis.
 *
 * Meridian's three actions are unchanged — "Why was this flagged?",
 * "Assemble case file", "Draft review summary" — but every sentence is now
 * generated from the backend's real assessment JSON: triggered rule
 * descriptions, hard overrides, and the model's own topDeviations.
 *
 * Nothing here invents a score or a risk judgement. It narrates what the
 * backend already decided, which is what keeps the output auditable.
 */

import { actionLabel, deriveFlags, formatAmount, tierOf } from "./transform.js";

function subject(assessment) {
  const txn = assessment.transaction;
  const amount = formatAmount(txn);
  const corridor =
    txn?.originatorCountry && txn?.destinationCountry
      ? ` routed ${txn.originatorCountry} → ${txn.destinationCountry}`
      : "";
  const product = txn?.productType ? txn.productType.toLowerCase() : "transaction";
  return {
    product,
    amount,
    corridor,
    client: txn?.originatorName ?? `transaction ${assessment.transactionId}`,
  };
}

/* ---------- 1. Why was this flagged? ---------- */
export function whyBlocks(assessment) {
  const tier = tierOf(assessment.assessment?.riskLevel);

  if (assessment.detailAvailable === false) {
    return [
      `This record scored <b>${assessment.assessment?.overallScore}/100</b> and was banded <b>${tier.name}</b>, ` +
        `but the scoring detail was not stored alongside it.`,
      `Without the triggered rules and model signals there is nothing to attribute the score to, ` +
        `so no rationale can be given here. Re-assessing the transaction through the API rebuilds the full record.`,
    ];
  }
  const b = assessment.scoreBreakdown ?? {};
  const rules = [...(assessment.rulesTriggered ?? [])].sort((a, z) => z.points - a.points);
  const overrides = assessment.hardOverrides ?? [];
  const s = subject(assessment);

  const paragraphs = [];

  const lead = s.amount
    ? `This ${s.product} of <b>${s.amount}</b>${s.corridor} for ${s.client}`
    : `Transaction <b>${assessment.transactionId}</b>`;

  if (overrides.length > 0) {
    paragraphs.push(
      `${lead} carries a <b>hard override</b>: ${overrides
        .map((o) => o.description.toLowerCase())
        .join(", ")}. Policy ${assessment.policyVersion} floors the score at ` +
        `${Math.max(...overrides.map((o) => o.minimumScore))}, so the weighted calculation cannot lower it. ` +
        `Outcome is fixed at <b>${tier.name}</b> — ${actionLabel(assessment.assessment?.recommendedAction).toLowerCase()}.`,
    );
  } else {
    const top = rules.slice(0, 3).map((r) => r.description.toLowerCase());
    paragraphs.push(
      `${lead} ranks <b>${tier.name}</b> at ${assessment.assessment?.overallScore}/100, driven mainly by ` +
        `${top.length ? top.join("; ") : "no individual rule breaches"}.`,
    );
  }

  if (b.anomalyAvailable) {
    const deviations = assessment.modelSignals?.topDeviations ?? [];
    paragraphs.push(
      `The SAP AI Core behavioural model scored this <b>${b.anomalyScore}/100</b> ` +
        `(band ${assessment.modelSignals?.anomalyBand ?? "—"}, model ${assessment.modelSignals?.modelVersion ?? "unknown"}) ` +
        `and contributes ${Math.round((b.anomalyWeight ?? 0) * 100)}% of the final score. ` +
        (deviations.length
          ? `Its own stated reasons: ${deviations.map((d) => d.toLowerCase()).join("; ")}.`
          : `It identified no single dominant feature deviation.`),
    );
  } else {
    paragraphs.push(
      `The anomaly model was <b>unavailable</b> for this assessment, so the score is 100% deterministic rules. ` +
        `The decision stays available and auditable — the response reports <code>MODEL_UNAVAILABLE</code> rather than failing.`,
    );
  }

  paragraphs.push(
    `Every point above is attributable to a named rule in policy ${assessment.policyVersion}, so the reasoning can be recorded on the case file verbatim.`,
  );

  return paragraphs;
}

/* ---------- 2. Assemble case file ---------- */
export function caseFileItems(assessment) {
  const flags = deriveFlags(assessment);
  const txn = assessment.transaction;
  const items = [
    `KYC profile & beneficial-ownership chart — ${txn?.originatorName ?? "originator company"} (HANA COMPANIES, COMPANY_BENEFICIAL_OWNERS)`,
    `Counterparty registry entry — beneficiary${txn?.destinationCountry ? ` in ${txn.destinationCountry}` : ""} (HANA COUNTRIES)`,
    `Behavioural history — ${assessment.historyTransactionCount ?? 0} prior transactions from the same originator`,
    `Feature snapshot at assessment time — 9 behavioural features passed to SAP AI Core`,
  ];

  if (flags.find((f) => f.key === "sanctions")?.on) {
    items.push("Sanctions screening log & match detail — hard override evidence pack");
  }
  if (flags.find((f) => f.key === "pep")?.on) {
    items.push("PEP database record & beneficial-owner source list");
  }
  if (flags.find((f) => f.key === "adverse")?.on) {
    items.push("Adverse-media dossier");
  }
  if (flags.find((f) => f.key === "structuring")?.on) {
    items.push("Near-threshold transaction cluster — structuring evidence (rolling 24h)");
  }

  items.push(`Scoring record — policy ${assessment.policyVersion}, assessed ${assessment.generatedAt ? new Date(assessment.generatedAt).toISOString() : "—"}`);
  return items;
}

/* ---------- 3. Draft review summary ---------- */
export function draftSummary(assessment) {
  const tier = tierOf(assessment.assessment?.riskLevel);
  const s = subject(assessment);
  const rules = [...(assessment.rulesTriggered ?? [])].sort((a, z) => z.points - a.points).slice(0, 3);
  const b = assessment.scoreBreakdown ?? {};
  const overrides = assessment.hardOverrides ?? [];

  const header = s.amount
    ? `${assessment.alertId} — ${s.product} of ${s.amount}${s.corridor} for ${s.client}.`
    : `${assessment.alertId} — transaction ${assessment.transactionId}.`;

  const composition = b.anomalyAvailable
    ? `Composition: rules ${b.ruleScore}/100 at ${Math.round(b.ruleWeight * 100)}% + anomaly ${b.anomalyScore}/100 at ${Math.round(b.anomalyWeight * 100)}%.`
    : `Composition: rules ${b.ruleScore}/100 at 100% (anomaly model unavailable).`;

  const overrideLine = overrides.length
    ? ` Hard override applied: ${overrides.map((o) => o.ruleId).join(", ")} — score floored at ${Math.max(...overrides.map((o) => o.minimumScore))}.`
    : "";

  const drivers = rules.length
    ? ` Principal drivers: ${rules.map((r) => `${r.description.toLowerCase()} (+${r.points})`).join("; ")}.`
    : "";

  const rec =
    tier.name === "Critical" || tier.name === "High"
      ? "escalate for SAR consideration"
      : tier.name === "Watch"
        ? "hold for enhanced review"
        : "close with rationale on file";

  return (
    `${header} Assigned ${tier.name} priority (score ${assessment.assessment?.overallScore}/100, policy ${assessment.policyVersion}). ` +
    `${composition}${overrideLine}${drivers} ` +
    `Recommended action: ${rec}. Prepared for analyst review — not yet actioned.`
  );
}
