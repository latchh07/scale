import React from "react";

/**
 * New. The backend can floor a score at 95-100 via a sanctions hard override,
 * which bypasses the weighted calculation entirely. That is the single most
 * consequential thing the engine does, so it gets its own banner.
 */
export default function OverrideBanner({ overrides, policyVersion }) {
  if (!overrides || overrides.length === 0) return null;
  const floor = Math.max(...overrides.map((o) => Number(o.minimumScore)));

  return (
    <div className="override" role="note">
      <span className="mark" aria-hidden="true">!</span>
      <div className="otxt">
        <b>Hard override applied.</b> Policy {policyVersion} floors this score at {floor}/100.
        The weighted rule and anomaly calculation cannot reduce it.
        <ul>
          {overrides.map((o) => (
            <li key={o.ruleId}>
              <span className="rid">{o.ruleId}</span>
              <span>{o.description} · minimum {o.minimumScore}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
