import React from "react";
import { deriveFlags } from "../lib/transform.js";

/** Meridian's four flags — now derived from real rule IDs in risk-policy.json. */
export default function FlagStrip({ assessment }) {
  const flags = deriveFlags(assessment);
  return (
    <div className="flags">
      {flags.map((f) => (
        <span key={f.key} className={`flag${f.on ? "" : " muted"}`}>
          <span className="dot" aria-hidden="true" />
          {f.label}
          {f.on ? "" : " — none"}
        </span>
      ))}
    </div>
  );
}
