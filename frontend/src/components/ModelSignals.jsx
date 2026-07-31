import React from "react";

/**
 * New. Surfaces the explainability the Isolation Forest already produces
 * (ai-core/narrow_ai/src/risk_anomaly/model.py -> score_row), plus the
 * MODEL_UNAVAILABLE state the backend reports when AI Core cannot be reached.
 */
export default function ModelSignals({ assessment }) {
  const signals = assessment.modelSignals ?? {};
  const breakdown = assessment.scoreBreakdown ?? {};
  const unavailable = !breakdown.anomalyAvailable || signals.status === "MODEL_UNAVAILABLE";

  if (unavailable) {
    return (
      <section className="signals unavailable" aria-label="Anomaly model signals">
        <div className="shead">
          <h3>Behavioural anomaly model</h3>
          <span className="sver">SAP AI Core · not reached</span>
        </div>
        <p className="fallback">
          <b>MODEL_UNAVAILABLE.</b> The assessment fell back to a 100% deterministic rule score,
          so triage is unaffected and the decision stays auditable. Sanctions, PEP, KYC and
          geography are compliance rules and never depended on the model.
        </p>
      </section>
    );
  }

  const band = String(signals.anomalyBand ?? "").toLowerCase();
  const deviations = signals.topDeviations ?? [];

  return (
    <section className="signals" aria-label="Anomaly model signals">
      <div className="shead">
        <h3>Behavioural anomaly model</h3>
        <span className="sver">
          <span className={`band-chip b-${band}`}>{signals.anomalyBand ?? "—"}</span>
          &nbsp; {breakdown.anomalyScore}/100 · {signals.modelVersion ?? "unknown"}
          {signals.anomalyFlag ? " · flagged" : ""}
        </span>
      </div>
      <ul className="deviations">
        {deviations.length === 0 && <li>No dominant feature deviation identified.</li>}
        {deviations.map((d, i) => (
          <li key={i}>
            <span className="idx" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
            <span>{d}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
