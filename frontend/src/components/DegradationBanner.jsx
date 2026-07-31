import React, { useState } from "react";

/**
 * Names a backend fault instead of letting the dashboard quietly show stale or
 * demo numbers. The queue keeps rendering underneath — an analyst losing the
 * screen mid-review is worse than an analyst seeing a warning above it.
 *
 * Inline code spans are written as `backticks` in the fault text and rendered
 * as <code> here, so the remedy stays copy-pasteable.
 */
function withCode(text) {
  return String(text)
    .split(/`([^`]+)`/g)
    .map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

export default function DegradationBanner({ fault, showingDemoData }) {
  const [dismissed, setDismissed] = useState(false);
  if (!fault || dismissed) return null;

  const severe = fault.kind === "PERSISTENCE_FAILED" || fault.kind === "API_UNREACHABLE";

  return (
    <div className={`degraded${severe ? " severe" : ""}`} role="status">
      <span className="dmark" aria-hidden="true">{severe ? "!" : "i"}</span>
      <div className="dtxt">
        <div className="dtitle">
          {fault.title}
          {showingDemoData && <span className="dtag">showing demo data</span>}
        </div>
        {fault.detail && <p className="ddetail">{withCode(fault.detail)}</p>}
        {fault.remedy && <p className="dremedy">{withCode(fault.remedy)}</p>}
      </div>
      <button
        type="button"
        className="ddismiss"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss this warning"
      >
        ×
      </button>
    </div>
  );
}
