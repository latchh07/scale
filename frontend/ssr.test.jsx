/**
 * Feature-parity smoke test.  Run with: npm run verify
 *
 * Two things are checked:
 *
 *  1. Every alert renders end-to-end without throwing (server-side render of
 *     the masthead, queue, all six case panels and all six assistants).
 *  2. Every feature carried over from the original meridian.html is still
 *     present in the rendered markup — tier chips, filter pills, the flag
 *     strip, the ledger, the Joule actions, the accountability note, the
 *     skip link — alongside the new backend-driven sections.
 *
 * This is deliberately dependency-free: no jest, no testing-library, no
 * jsdom. esbuild bundles it, node runs it.
 */
import React from "react";
import { renderToString } from "react-dom/server";

import App from "./src/App.jsx";
import Masthead from "./src/components/Masthead.jsx";
import QueueRail from "./src/components/QueueRail.jsx";
import CasePanel from "./src/components/CasePanel.jsx";
import Assistant from "./src/components/Assistant.jsx";
import { MOCK_ASSESSMENTS } from "./src/api/mockData.js";

let html = "";
html += renderToString(
  <Masthead mode="demo" health={{ policyVersion: "2.1.0" }} onToggleMode={() => {}} busy={false} />,
);
html += renderToString(
  <QueueRail
    alerts={MOCK_ASSESSMENTS}
    selectedId="ALT-4471"
    onSelect={() => {}}
    filter="all"
    onFilter={() => {}}
    totalPool="12,000"
  />,
);
for (const a of MOCK_ASSESSMENTS) {
  html += renderToString(<CasePanel assessment={a} caseRef={{ current: null }} />);
  html += renderToString(<Assistant assessment={a} />);
}
html += renderToString(<App />);

const CHECKS = [
  // --- carried over from meridian.html ---
  ["masthead brand", "Meridian"],
  ["masthead kicker", "Financial Crime Operations"],
  ["analyst identity", "E. Okafor"],
  ["queue heading", "Alerts by exposure"],
  ["queue subtitle", "alerts · ranked by regulatory exposure"],
  ["alert pool size", "12,000"],
  ["filter pill: Critical", ">Critical<"],
  ["filter pill: Watch", ">Watch<"],
  ["tier chip: critical", "tier-chip t-crit"],
  ["tier chip: high", "tier-chip t-high"],
  ["tier chip: watch", "tier-chip t-watch"],
  ["tier chip: low", "tier-chip t-low"],
  ["composite score", 'class="composite"'],
  ["score out of 100", "/100"],
  ["case facts strip", "case-facts"],
  ["flag: sanctions", "Sanctions screening hit"],
  ["flag: PEP", "PEP linkage"],
  ["flag: adverse media", "Adverse media"],
  ["flag: structuring", "Structuring pattern"],
  ["flag: muted variant", "flag muted"],
  ["ledger: why this ranks here", "Why this ranks here"],
  ["ledger: progress track", 'class="track"'],
  ["ledger: weight badge", "wbadge"],
  ["joule badge", "Joule · Risk Intelligence"],
  ["action: why flagged", "Why was this flagged?"],
  ["action: assemble case file", "Assemble case file"],
  ["action: draft summary", "Draft review summary"],
  ["accountability note", "Decision support only."],
  ["skip link", "Skip to selected case"],
  // --- new, backed by the Team 12 risk engine ---
  ["hard override marker (queue)", "ovr-mark"],
  ["hard override banner", "Hard override applied"],
  ["score composition ledger", "How this score is composed"],
  ["model signals panel", "Behavioural anomaly model"],
  ["model unavailable fallback", "MODEL_UNAVAILABLE"],
  ["feature snapshot", "Feature snapshot sent to the model"],
];

let failed = 0;
for (const [name, needle] of CHECKS) {
  if (!html.includes(needle)) {
    console.log(`  MISSING: ${name}  ->  ${needle}`);
    failed++;
  }
}

console.log(
  `Rendered ${MOCK_ASSESSMENTS.length} cases without error (${html.length} chars). ` +
    `${CHECKS.length - failed}/${CHECKS.length} feature markers present.`,
);
process.exit(failed ? 1 : 0);
