import React from "react";

/**
 * Meridian masthead, plus a live/demo switch so the data source is never
 * ambiguous during a demo — the analyst can always see whether the numbers
 * came from HANA or from fixtures.
 */
export default function Masthead({ mode, health, onToggleMode, busy, live, lastPoll }) {
  const isLive = mode === "live";
  return (
    <header className="masthead">
      <div className="brand">
        <h1>Meridian</h1>
        <div className="kicker">
          <span className="eyebrow">TrustSphere Bank</span>
          <span className="eyebrow">Financial Crime Operations</span>
        </div>
      </div>

      <div className="who">
        <div className="datamode">
          <button
            type="button"
            className={`mode-chip${isLive ? " live" : ""}`}
            onClick={onToggleMode}
            disabled={busy}
            aria-label={isLive ? "Live data from SAP HANA. Switch to demo data." : "Demo data. Switch to live data."}
            title={isLive ? "Reading live assessments from the risk API" : "Reading bundled demo fixtures"}
          >
            <span className="lamp" aria-hidden="true" />
            {busy ? "Loading" : isLive ? "Live · HANA" : "Demo data"}
          </button>
          <span className="mode-note">
            policy {health?.policyVersion ?? "—"}
            {isLive ? (health?.anomalyServiceConfigured ? " · AI Core on" : " · AI Core off") : ""}
            {live && lastPoll
              ? ` · synced ${lastPoll.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
              : ""}
          </span>
        </div>

        <div>
          <div className="name">E. Okafor</div>
          <div className="role">FCO Analyst · Compliance Ops, Singapore</div>
        </div>
        <div className="avatar" aria-hidden="true">EO</div>
      </div>
    </header>
  );
}
