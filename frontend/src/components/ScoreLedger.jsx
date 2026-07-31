import React, { useEffect, useRef } from "react";
import { ruleLedger, scoreComposition } from "../lib/transform.js";

/**
 * Meridian's weighted factor ledger, in two parts:
 *
 *  1. Score composition — the backend's actual 80/20 split between deterministic
 *     rules and the SAP AI Core anomaly score.
 *  2. Rules triggered — every rule the engine fired, with its point award,
 *     ordered by contribution exactly like the original.
 */
export default function ScoreLedger({ assessment }) {
  const composition = scoreComposition(assessment);
  const rules = ruleLedger(assessment);
  const ref = useRef(null);

  // Bars animate in from zero on every case change, as in the original.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      ref.current?.querySelectorAll(".fill").forEach((el) => {
        el.style.width = `${el.dataset.w}%`;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [assessment.alertId, assessment.transactionId]);

  return (
    <div ref={ref}>
      <div className="ledger-head">
        <h3>How this score is composed</h3>
        <span className="hint">weighted per policy {assessment.policyVersion}</span>
      </div>
      <div className="ledger">
        {composition.map((c, i) => (
          <div key={c.key} className={`frow${i === 0 ? " rank1" : ""}${c.available ? "" : " dim"}`}>
            <span className="fname">
              <span className="wbadge">{c.weightLabel}</span>
              {c.name}
            </span>
            <span className="track">
              <span className="fill" data-w={c.sub} />
            </span>
            <span className="ffig">
              {c.available ? (
                <>
                  <b>{c.sub}</b> / 100 &nbsp;<span className="contrib">+{c.contrib}</span>
                </>
              ) : (
                <span style={{ fontSize: "10.5px" }}>unavailable</span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="ledger-head">
        <h3>Why this ranks here</h3>
        <span className="hint">rules triggered, ordered by contribution</span>
      </div>
      <div className="ledger">
        {rules.length === 0 && (
          <p className="ledger-empty">No compliance rules were triggered. The score is behavioural only.</p>
        )}
        {rules.map((r, i) => (
          <div key={r.ruleId} className={`frow${i === 0 ? " rank1" : ""}`}>
            <span className="fname">
              <span className="wbadge pts">+{r.points}</span>
              {r.description}
            </span>
            <span className="track">
              <span className="fill" data-w={r.barWidth} />
            </span>
            <span className="ffig" title={r.ruleId}>
              <b>{r.points}</b> pts
              <br />
              <span className="mono" style={{ fontSize: "9px", letterSpacing: ".04em", color: "var(--ink-3)" }}>
                {r.ruleId}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
