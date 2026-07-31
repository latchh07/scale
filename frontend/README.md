# Meridian — Team 12 frontend

The Financial Crime Operations workbench for TrustSphere Bank, rebuilt in React
and wired to the Team 12 risk backend.

This is a ground-up React implementation of the original `meridian.html`
prototype. Every feature from that prototype is preserved; the difference is
that the numbers are no longer hardcoded. Scores, tiers, flags and rationale now
come from `POST /api/risk-assessments/from-transaction`.

---

## Just want to look at it?

Open **`preview.html`** — double-click it, no install, no server. It is the whole
app bundled into one file, pinned to demo data. Everything works: filtering,
selecting cases, the assistant, the draft and the sign-off.

Use it for the pitch if you want a zero-risk demo. For live HANA data, run the
dev server below.

---

## Run it

```bash
cd frontend
npm install
cp .env.example .env.local     # optional — sensible defaults are built in
npm run dev
```

Opens on <http://localhost:5173>.

It works with **no backend running**. On startup it pings the risk API; if the
API is unreachable it falls back to bundled demo fixtures and says so in the
masthead. The live/demo switch in the masthead flips between them at any time,
so a failed HANA connection can never kill a demo mid-pitch.

To run against the real thing, start Chengxi's backend first:

```bash
cd ../backend
npm start          # needs HANA_* variables set — see backend/.env.example
```

Other scripts:

```bash
npm run verify     # renders all six cases + asserts every Meridian feature is present
npm run build      # production bundle into dist/
```

---

## How it talks to the backend

Per `docs/frontend-risk-integration.md`, the frontend **never** calls SAP HANA
or SAP AI Core directly and **never** recalculates a score. It calls the backend
and renders what comes back.

| Call | Purpose |
| --- | --- |
| `GET /health` | Decides live vs demo mode; reads `policyVersion` and `anomalyServiceConfigured` for the masthead |
| `GET /api/risk-assessments/history` | The ranked queue. Polled every few seconds for new alerts |
| `GET /api/risk-assessments/history/:id` | Full persisted record for a queue row |
| `POST /api/risk-assessments/from-transaction` | Fallback when nothing is persisted yet: HANA context → 9 behavioural features → SAP AI Core → policy engine |

The queue loads with a three-step fallback, so it always renders something:

1. `/history` — the persisted, ranked queue (preferred)
2. per-transaction assessment of `VITE_TRANSACTION_IDS`
3. bundled demo fixtures

### Live feed

When the queue is backed by `/history`, the dashboard polls every
`VITE_POLL_INTERVAL_MS` (default 5s) and merges newly persisted assessments in
at their ranked position with a brief highlight. Run the simulator in a terminal
and alerts land in the queue while you watch:

```bash
cd ../backend
npm run simulate -- --watch --interval 5000     # ambient traffic
npm run simulate -- sanctions                   # a Critical, on cue
```

Only unseen `assessmentId`s are hydrated, so polling stays cheap, and the merge
is de-duplicated so an overlapping tick cannot insert the same alert twice.

Every field of the response is used:

| Backend field | Where it appears |
| --- | --- |
| `assessment.overallScore` | Queue score, giant composite score |
| `assessment.riskLevel` | Tier chip, colour, filter pills |
| `assessment.recommendedAction` | Queue footer, "Recommended" fact, draft summary |
| `assessment.hardOverride` | `Override` marker on the queue row |
| `scoreBreakdown.*` | "How this score is composed" ledger (the real 80/20 split) |
| `rulesTriggered[]` | "Why this ranks here" ledger, ordered by points |
| `hardOverrides[]` | Hard-override banner, sanctions flag |
| `modelSignals.topDeviations` | Behavioural anomaly model panel |
| `modelSignals.status` | `MODEL_UNAVAILABLE` fallback state |
| `featureSnapshot` | Collapsible feature snapshot |
| `historyTransactionCount` | Prior-history fact |
| `policyVersion` / `generatedAt` | Audit footer, masthead |

### Tier mapping

Meridian ships four tiers; the policy ships four bands. They line up one-to-one,
so the original filter pills and colours are untouched:

| `risk-policy.json` band | Score | Meridian tier | Colour |
| --- | ---: | --- | --- |
| `CRITICAL` | 85–100 | Critical | `--crit` |
| `HIGH` | 65–84 | High | `--high` |
| `MEDIUM` | 35–64 | **Watch** | `--watch` |
| `LOW` | 0–34 | Low | `--low` |

### Flags

The prototype's four flags were hardcoded booleans. They are now derived from
real rule and override IDs:

| Flag | Source |
| --- | --- |
| Sanctions screening hit | `ENTITY_SANCTIONS_MATCH`, `BENEFICIAL_OWNER_SANCTIONS_MATCH`, `SANCTIONED_DESTINATION` (hard overrides) |
| PEP linkage | `PEP_EXPOSURE` |
| Adverse media | `ADVERSE_MEDIA` |
| Structuring pattern | `STRUCTURING_PATTERN` |

---

## What was added to the prototype

Everything in `meridian.html` is still here. These are the additions, each one
surfacing something the backend already produces:

- **Hard-override banner.** A sanctions match floors the score at 95–100 and
  bypasses the weighted calculation. That is the most consequential thing the
  engine does, so it gets its own callout rather than hiding inside the ledger.
- **Score composition ledger.** The real `rules × 80% + anomaly × 20%` split,
  shown above the rule-by-rule breakdown.
- **Rule ledger with policy IDs.** Every triggered rule with its point award and
  its `ruleId`, so a reviewer can trace a number back to `risk-policy.json`.
- **Behavioural anomaly panel.** The Isolation Forest's own `topDeviations`
  explanations, its band, and its model version.
- **`MODEL_UNAVAILABLE` state.** When AI Core is unreachable the backend falls
  back to a 100% rule score. The UI says so explicitly instead of silently
  showing a different number.
- **Feature snapshot.** The nine behavioural features sent to the model,
  collapsed by default, with a note that KYC/sanctions/PEP/adverse-media are
  never sent to it.
- **Live/demo switch.** So the data source is never ambiguous during a demo.

The assistant keeps its three original actions, but every sentence is now
generated from the real assessment JSON — triggered rule descriptions, override
IDs, and the model's own stated reasons. It still never decides anything: the
analyst approves, and the accountability note is unchanged.

---

## One change made to the backend

`backend/src/server.js` was given an optional `transaction` block — the
descriptive detail (amount, corridor, counterparty) that the Amount / Corridor /
Client facts render. It is additive and backwards compatible: nothing breaks if
the block is absent, and the UI already degraded gracefully without it.

- `POST /api/risk-assessments` now passes `payload.transaction` through to the
  persisted record. This is what lets simulated alerts carry case context.
- `POST /api/risk-assessments/from-transaction` builds the same block from the
  HANA context it had already loaded.

Worth flagging to Chengxi, since it touches his file. `npm test` in `backend`
still passes (8/8).

`originatorCountry` and `productType` are left `null` on the live route —
`hana-context.js` does not currently select the originator's country or the
product type. Adding them to that query would fill in the last two facts.

---

## Structure

```
frontend/
├── index.html
├── ssr.test.jsx              # npm run verify — feature-parity smoke test
└── src/
    ├── App.jsx               # layout, data loading, selection, live/demo
    ├── styles.css            # Meridian design system, ported verbatim
    ├── api/
    │   ├── client.js         # health, from-transaction, fallback, optional Joule
    │   └── mockData.js       # demo fixtures in the exact backend schema
    ├── lib/
    │   ├── transform.js      # backend JSON → view model
    │   └── assistant.js      # rationale / case file / draft synthesis
    └── components/
        ├── Masthead.jsx      ├── QueueRail.jsx     ├── CasePanel.jsx
        ├── TierChip.jsx      ├── FlagStrip.jsx     ├── OverrideBanner.jsx
        ├── ScoreLedger.jsx   ├── ModelSignals.jsx  ├── FeatureSnapshot.jsx
        └── Assistant.jsx
```

### Optional: Latchiya's RAG service

Set `VITE_JOULE_API_BASE_URL` and "Why was this flagged?" will additionally call
`POST /api/investigate` on the Python service and append the generated
compliance narrative. Leave it blank and the assistant synthesises locally —
no network call, no failure mode.

---

## Demo fixtures

Six alerts spanning all four tiers, including one (`ALT-4356`) that exercises
the `MODEL_UNAVAILABLE` path. Their scores were computed by hand against
`risk-policy.json` v2.1.0 — exclusive groups, hard-override flooring, the 80/20
weighting and the band cutoffs all check out, and `npm run verify` re-derives
them on every run. The demo numbers are arithmetically honest, not invented.
