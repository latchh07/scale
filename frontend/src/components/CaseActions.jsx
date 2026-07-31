import React from "react";
import { tierOf } from "../lib/transform.js";

/**
 * The analyst's decision on the open case.
 *
 * Pinned to the bottom of the case column so it is reachable at any scroll
 * position — an analyst should never have to hunt for the decision they came
 * here to make.
 *
 * Approve releases the payment, Decline blocks it. Either way the alert leaves
 * the queue. Both are human actions: nothing here decides on its own.
 */
export default function CaseActions({ assessment, onResolve }) {
  const tier = tierOf(assessment.assessment?.riskLevel);
  const score = Math.round(Number(assessment.assessment?.overallScore ?? 0));

  return (
    <div className="case-actions">
      <div className="ca-context">
        <span className="ca-label">Analyst decision</span>
        <span className="ca-detail">
          {assessment.alertId ?? `TXN ${assessment.transactionId}`} · {tier.name} · {score}/100
        </span>
      </div>
      <div className="ca-buttons">
        <button
          type="button"
          className="btn btn-approve"
          onClick={() => onResolve(assessment, "approved")}
        >
          Approve &amp; release
        </button>
        <button
          type="button"
          className="btn btn-decline"
          onClick={() => onResolve(assessment, "declined")}
        >
          Decline &amp; block
        </button>
      </div>
    </div>
  );
}
