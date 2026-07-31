import React from "react";
import TierChip from "./TierChip.jsx";
import FlagStrip from "./FlagStrip.jsx";
import OverrideBanner from "./OverrideBanner.jsx";
import ScoreLedger from "./ScoreLedger.jsx";
import ModelSignals from "./ModelSignals.jsx";
import FeatureSnapshot from "./FeatureSnapshot.jsx";
import CaseActions from "./CaseActions.jsx";
import { buildFacts, caseLabel, formatTimestamp, tierOf } from "../lib/transform.js";

export default function CasePanel({ assessment, caseRef, onResolve }) {
  const tier = tierOf(assessment.assessment?.riskLevel);
  const score = Math.round(Number(assessment.assessment?.overallScore ?? 0));
  const facts = buildFacts(assessment);
  const b = assessment.scoreBreakdown ?? {};

  const detailAvailable = assessment.detailAvailable !== false;

  const formula = assessment.assessment?.hardOverride
    ? "Hard override in force — score floored by policy, weighted result superseded."
    : b.anomalyAvailable
      ? `Final = (rules × ${Math.round(b.ruleWeight * 100)}%) + (anomaly × ${Math.round(b.anomalyWeight * 100)}%). Human review required before any action.`
      : "Final = rule score × 100% (model unavailable). Human review required before any action.";

  return (
    <section
      className="case"
      id="case"
      ref={caseRef}
      aria-label="Selected case detail"
      tabIndex={-1}
      style={{ "--tier": tier.color }}
    >
      <div className="case-eyebrow">
        <span className="eyebrow">
          {caseLabel(assessment) ?? `Case · ${assessment.alertId ?? "unassigned"}`}
        </span>
        <span className="rule" aria-hidden="true" />
        <span className="eyebrow">
          {assessment.alertId ? `${assessment.alertId} · ` : ""}TXN {assessment.transactionId}
        </span>
      </div>

      <div className="score-block">
        <div className="composite" aria-hidden="true">
          {score}
          <span className="outof">/100</span>
        </div>
        <div className="score-side">
          <div className="tierline">
            <TierChip
              riskLevel={assessment.assessment?.riskLevel}
              suffix=" priority"
              style={{ fontSize: "11px", padding: "4px 10px" }}
            />
          </div>
          <div className="tier-band">Priority score {score}</div>
          <p className="formula">{formula}</p>
        </div>
      </div>

      <div className="case-facts">
        {facts.map((f) => (
          <div className="fact" key={f.label}>
            <div className="flabel">{f.label}</div>
            <div className={`fval${f.small ? " small" : ""}${f.dim ? " dim" : ""}`}>{f.value}</div>
          </div>
        ))}
      </div>

      {detailAvailable ? (
        <>
          <FlagStrip assessment={assessment} />

          <OverrideBanner
            overrides={assessment.hardOverrides}
            policyVersion={assessment.policyVersion}
          />

          <ScoreLedger assessment={assessment} />

          <ModelSignals assessment={assessment} />

          <FeatureSnapshot
            snapshot={assessment.featureSnapshot}
            historyCount={assessment.historyTransactionCount}
          />
        </>
      ) : (
        <section className="signals unavailable" aria-label="Scoring detail">
          <div className="shead">
            <h3>Scoring detail not stored</h3>
            <span className="sver">summary record</span>
          </div>
          <p className="fallback">
            This assessment has a score, tier and recommended action, but no stored
            <code> ASSESSMENT_JSON</code>, so the triggered rules, model signals and
            feature snapshot cannot be shown. Rows inserted directly by SQL look like
            this. Re-assessing through the API produces the full record.
          </p>
        </section>
      )}

      {onResolve && <CaseActions assessment={assessment} onResolve={onResolve} />}

      <p className="mono" style={{ fontSize: "10.5px", color: "var(--ink-3)", marginTop: "26px", letterSpacing: ".04em" }}>
        Assessed {formatTimestamp(assessment.generatedAt)} · policy {assessment.policyVersion}
        {assessment.persistence === "SAVED" ? " · saved to HANA" : ""}
        {assessment.reviewStatus ? ` · ${assessment.reviewStatus.toLowerCase()}` : ""}
      </p>
    </section>
  );
}
