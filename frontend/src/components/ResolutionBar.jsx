import React from "react";

/**
 * Confirms the decision just taken and offers a short window to reverse it.
 *
 * A misclick that silently removes a case would be worse than the extra strip,
 * so undo restores the alert to its ranked position.
 */
export default function ResolutionBar({ resolution, onUndo, onDismiss }) {
  if (!resolution) return null;
  const approved = resolution.decision === "approved";

  return (
    <div className={`resolved${approved ? " approve" : " decline"}`} role="status">
      <span className="rmark" aria-hidden="true">{approved ? "✓" : "✕"}</span>
      <div className="rtxt">
        <b>{resolution.alertId ?? `TXN ${resolution.transactionId}`}</b>{" "}
        {approved ? "approved — payment released." : "declined — payment blocked."}{" "}
        <span className="rmuted">Removed from the triage queue.</span>
      </div>
      <button type="button" className="rundo" onClick={onUndo}>Undo</button>
      <button type="button" className="rdismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  );
}
