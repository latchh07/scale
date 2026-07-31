import React from "react";
import { tierOf } from "../lib/transform.js";

/** Meridian's tier chip: coloured pill with a shape glyph (triangle / diamond / circle / square). */
export default function TierChip({ riskLevel, suffix = "", style }) {
  const tier = tierOf(riskLevel);
  return (
    <span className={`tier-chip ${tier.cls}`} style={{ "--tier": tier.color, ...style }}>
      <span className="glyph" aria-hidden="true" />
      {tier.name}
      {suffix}
    </span>
  );
}
