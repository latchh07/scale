import React from "react";
import { featureCells } from "../lib/transform.js";

/**
 * New. The nine behavioural features the backend derived from HANA history and
 * sent to SAP AI Core. Collapsed by default — this is audit detail, not triage
 * detail, and Meridian's case panel stays uncluttered.
 */
export default function FeatureSnapshot({ snapshot, historyCount }) {
  const cells = featureCells(snapshot);
  if (cells.length === 0) return null;

  return (
    <details className="snapshot">
      <summary>
        Feature snapshot sent to the model · {historyCount ?? 0} prior transactions
      </summary>
      <div className="fgrid">
        {cells.map((c) => (
          <div className="fcell" key={c.key}>
            <div className="fk">{c.label}</div>
            <div className={`fv${c.state ? ` ${c.state}` : ""}`}>{c.value}</div>
          </div>
        ))}
      </div>
      <p style={{ fontSize: "11.5px", color: "var(--ink-3)", lineHeight: 1.55, margin: "10px 0 0" }}>
        Behavioural features only. KYC, sanctions, PEP and adverse-media facts are
        never sent to the model — they stay in the deterministic rule engine.
      </p>
    </details>
  );
}
