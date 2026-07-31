/**
 * Client for the Team 12 risk backend (scale/backend).
 *
 * Contract, per docs/frontend-risk-integration.md: the frontend NEVER talks to
 * SAP HANA or SAP AI Core directly, and never recalculates a score. It calls
 * the backend and renders what comes back.
 *
 *   GET  /health
 *   GET  /api/risk-assessments/history?limit=N     ranked queue summaries
 *   GET  /api/risk-assessments/history/:id         full persisted assessment
 *   POST /api/risk-assessments/from-transaction    assess a HANA transaction
 */

import { MOCK_ASSESSMENTS, MOCK_HEALTH } from "./mockData.js";
import { isTriageable } from "../lib/transform.js";

const env = import.meta.env ?? {};

export const API_BASE_URL = (env.VITE_RISK_API_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const JOULE_BASE_URL = (env.VITE_JOULE_API_BASE_URL ?? "").replace(/\/$/, "");
export const FORCE_DEMO = String(env.VITE_FORCE_DEMO ?? "false") === "true";
export const QUEUE_LIMIT = Number(env.VITE_QUEUE_LIMIT ?? 40);
export const POLL_INTERVAL_MS = Number(env.VITE_POLL_INTERVAL_MS ?? 5000);

/** Fallback only: used when /history is unavailable (e.g. persistence not set up). */
export const TRANSACTION_IDS = String(env.VITE_TRANSACTION_IDS ?? "1,2,3,4,5,6")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const HEALTH_TIMEOUT_MS = 4000;
const DEFAULT_TIMEOUT_MS = 25000;
const HISTORY_TIMEOUT_MS = 25000;

/** assessment-store.js opens a fresh HANA connection per request, so detail
 *  fetches are throttled rather than fired all at once. */
const HYDRATE_CONCURRENCY = 3;

async function request(url, { timeout, ...init } = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeout ?? DEFAULT_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Carry the status and body through so callers can tell a persistence
    // failure (503) apart from a bad request or an unreachable host.
    // Node backend uses { error }; FastAPI (the Joule agent) uses { detail }.
    const message =
      payload.error ??
      (typeof payload.detail === "string" ? payload.detail : null) ??
      payload.details ??
      `Backend returned HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = payload;
    throw error;
  }
  return payload;
}

/* ---------- Fault classification -----------------------------------------
 * The backend on the ai-gen-and-rag branch answers 503 and discards the
 * assessment when the HANA write fails, rather than degrading to
 * persistence: "UNAVAILABLE". Either way the dashboard names the fault
 * instead of quietly showing stale or demo numbers.
 * ---------------------------------------------------------------------- */
export const FAULTS = {
  API_UNREACHABLE: (detail) => ({
    kind: "API_UNREACHABLE",
    title: "Risk API unreachable",
    detail,
    remedy: `Start the backend with \`npm start\` in scale/backend, then check ${API_BASE_URL}/health.`,
  }),
  PERSISTENCE_FAILED: (detail) => ({
    kind: "PERSISTENCE_FAILED",
    title: "Assessments are not being saved",
    detail,
    remedy:
      "The API returned 503 and discarded the score. Check HANA_* in team_12.env, " +
      "then run `npm run setup:assessment-store`.",
  }),
  HISTORY_UNAVAILABLE: (detail) => ({
    kind: "HISTORY_UNAVAILABLE",
    title: "Assessment history unavailable",
    detail,
    remedy: "The queue is falling back to direct assessment. Persisted history needs the HANA store.",
  }),
  PARTIAL_DETAIL: (partial, total) => ({
    kind: "PARTIAL_DETAIL",
    title: `${partial} of ${total} alerts have no stored detail`,
    detail:
      "These rows have a score and tier but no ASSESSMENT_JSON, so triggered rules, " +
      "model signals and the feature snapshot are unavailable for them.",
    remedy:
      "Rows written directly by SQL lack that column. Re-assess them through the API " +
      "with `npm run seed:hana` to get the full record.",
  }),
  NO_ASSESSMENTS: () => ({
    kind: "NO_ASSESSMENTS",
    title: "No assessments to triage",
    detail: "The risk API is healthy but the store is empty.",
    remedy: "Seed the queue with `npm run simulate -- --count 20` in scale/backend.",
  }),
};

/** True when an error means "the score was computed but could not be stored". */
function isPersistenceFault(error) {
  return (
    error?.status === 503 ||
    error?.body?.persistenceStatus === "FAILED" ||
    /persist/i.test(error?.message ?? "")
  );
}

export async function checkHealth() {
  return request(`${API_BASE_URL}/health`, { timeout: HEALTH_TIMEOUT_MS });
}

/** Ranked summaries. Cheap — safe to poll. */
export async function loadHistorySummaries(limit = QUEUE_LIMIT) {
  const payload = await request(
    `${API_BASE_URL}/api/risk-assessments/history?limit=${limit}`,
    { timeout: HISTORY_TIMEOUT_MS },
  );
  return payload.assessments ?? [];
}

/** Full persisted record, including rulesTriggered, modelSignals and featureSnapshot. */
export async function loadAssessmentById(assessmentId) {
  return request(`${API_BASE_URL}/api/risk-assessments/history/${assessmentId}`);
}

export async function assessTransaction(transactionId, alertId) {
  return request(`${API_BASE_URL}/api/risk-assessments/from-transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transactionId: String(transactionId),
      alertId: alertId ?? `ALT-${String(transactionId).padStart(4, "0")}`,
    }),
  });
}

/**
 * Build a renderable assessment from a queue summary alone.
 *
 * Rows written straight into RISK_ASSESSMENTS by SQL (rather than through the
 * API) have no ASSESSMENT_JSON, so the detail route cannot return rules, model
 * signals or a feature snapshot. The score, tier and action are still real, so
 * the alert is shown with `detailAvailable: false` and the case panel says what
 * is missing — rather than dropping the row or padding it with zeros that would
 * read as "no rules fired".
 */
export function fromSummary(summary) {
  return {
    assessmentId: summary.assessmentId,
    alertId: summary.alertId,
    transactionId: summary.transactionId,
    caseId: summary.caseId,
    sourceCaseId: summary.sourceCaseId,
    reviewStatus: summary.reviewStatus,
    generatedAt: summary.generatedAt,
    assessment: {
      overallScore: Number(summary.overallScore ?? 0),
      riskLevel: summary.riskLevel ?? "LOW",
      recommendedAction: summary.recommendedAction ?? "MONITOR",
      hardOverride: false,
    },
    scoreBreakdown: null,
    rulesTriggered: [],
    hardOverrides: [],
    modelSignals: {},
    policyVersion: null,
    detailAvailable: false,
  };
}

/** Fetch one full record, falling back to the summary projection. */
export async function hydrateOne(summary) {
  try {
    const detail = await loadAssessmentById(summary.assessmentId);
    if (detail?.assessment?.riskLevel) {
      return { ...detail, ...summary, detailAvailable: true };
    }
  } catch {
    // Fall through to the summary.
  }
  return fromSummary(summary);
}

/**
 * Hydrate in small batches so the backend is not asked for a dozen HANA
 * connections at once. `onProgress` receives each record as it lands, which
 * lets the queue render immediately and fill in detail as it arrives.
 */
export async function hydrateAll(summaries, onProgress) {
  const pending = [...summaries];
  const results = [];
  async function worker() {
    while (pending.length > 0) {
      const summary = pending.shift();
      const record = await hydrateOne(summary);
      results.push(record);
      onProgress?.(record);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(HYDRATE_CONCURRENCY, summaries.length) }, worker),
  );
  return results;
}

/** Kept for the polling path, which only ever handles a handful of new rows. */
async function hydrate(summaries) {
  return hydrateAll(summaries);
}

const demo = (fault) => ({
  mode: "demo",
  health: MOCK_HEALTH,
  alerts: MOCK_ASSESSMENTS,
  errors: [],
  fault,
});

/**
 * Load the triage queue, with layered fallback:
 *   1. /history  — the persisted, ranked queue (preferred)
 *   2. per-transaction assessment of VITE_TRANSACTION_IDS
 *   3. bundled demo fixtures
 */
export async function loadQueue() {
  if (FORCE_DEMO) return demo();

  let health;
  try {
    health = await checkHealth();
  } catch (error) {
    return demo(FAULTS.API_UNREACHABLE(`No response from ${API_BASE_URL} — ${error.message}`));
  }

  let historyFault = null;
  try {
    const summaries = await loadHistorySummaries();
    if (summaries.length > 0) {
      // Render straight from the summaries: score, tier and action are all
      // present, so the queue is usable after a single request. Full records
      // are fetched afterwards in the background.
      const triageable = summaries.filter((s) => Number(s.overallScore ?? 0) >= 1);
      return {
        mode: "live",
        source: "history",
        health,
        alerts: triageable.map(fromSummary),
        summaries: triageable,
        clearedCount: summaries.length - triageable.length,
        errors: [],
        fault: null,
      };
    } else {
      historyFault = FAULTS.NO_ASSESSMENTS();
    }
  } catch (error) {
    historyFault = isPersistenceFault(error)
      ? FAULTS.PERSISTENCE_FAILED(error.body?.details ?? error.message)
      : FAULTS.HISTORY_UNAVAILABLE(error.message);
  }

  const settled = await Promise.allSettled(TRANSACTION_IDS.map((id) => assessTransaction(id)));
  const alerts = [];
  const errors = [];
  let assessFault = null;
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      alerts.push(result.value);
    } else {
      errors.push({ transactionId: TRANSACTION_IDS[i], message: result.reason?.message ?? "Unknown error" });
      if (!assessFault && isPersistenceFault(result.reason)) {
        assessFault = FAULTS.PERSISTENCE_FAILED(result.reason.body?.details ?? result.reason.message);
      }
    }
  });

  const triageable = alerts.filter(isTriageable);
  if (triageable.length === 0) {
    return demo(assessFault ?? historyFault ?? FAULTS.NO_ASSESSMENTS());
  }

  return {
    mode: "live",
    source: "transactions",
    health,
    alerts: triageable,
    clearedCount: alerts.length - triageable.length,
    errors,
    fault: historyFault,
  };
}

/**
 * Poll for alerts that appeared since the last load.
 * Only new assessmentIds are hydrated, so this stays cheap on a timer.
 */
export async function pollForNewAlerts(knownIds) {
  try {
    const summaries = await loadHistorySummaries();
    const fresh = summaries.filter(
      (s) => s.assessmentId && !knownIds.has(s.assessmentId) && Number(s.overallScore ?? 0) >= 1,
    );
    return { alerts: fresh.length === 0 ? [] : await hydrate(fresh), fault: null };
  } catch (error) {
    return {
      alerts: [],
      fault: isPersistenceFault(error)
        ? FAULTS.PERSISTENCE_FAILED(error.body?.details ?? error.message)
        : FAULTS.API_UNREACHABLE(error.message),
    };
  }
}

export function loadDemoQueue() {
  return demo();
}

/* ---------- Joule agent ------------------------------------------------
 * Latchiya's compliance agent (backend/main.py on ai-gen-and-rag):
 *
 *   POST /api/joule/chat  { query, alert_id?, case_id?, context? }
 *     -> { title, sections: [{label, content}], recommendation,
 *          risk_factors: [{name, score, weight, rationale}] }
 *
 * It routes the query to one of five AML skills, gathers facts from HANA, and
 * synthesises through the orchestration pipeline (PII masking -> content
 * filter -> gpt-4o). Requests are only ever made when the analyst asks.
 * ---------------------------------------------------------------------- */

export const JOULE_ENABLED = Boolean(JOULE_BASE_URL);

const JOULE_TIMEOUT_MS = 60000; // routing + HANA lookup + gpt-4o

/** Only what her router actually reads, so nothing is invented downstream. */
function jouleContext(assessment) {
  const context = {};
  if (assessment?.assessmentId) context.assessment_id = String(assessment.assessmentId);
  if (assessment?.transactionId) context.transaction_id = String(assessment.transactionId);
  if (assessment?.transaction?.originatorName) {
    context.entity_name = assessment.transaction.originatorName;
  }
  return context;
}

export async function askJoule(query, assessment) {
  if (!JOULE_BASE_URL) {
    throw new Error("The Joule agent is not configured (VITE_JOULE_API_BASE_URL is unset).");
  }

  const body = { query, context: jouleContext(assessment) };
  if (assessment?.alertId) body.alert_id = String(assessment.alertId);
  if (assessment?.caseId != null) body.case_id = String(assessment.caseId);

  const payload = await request(`${JOULE_BASE_URL}/api/joule/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeout: JOULE_TIMEOUT_MS,
  });

  if (!payload?.title || !Array.isArray(payload.sections)) {
    throw new Error("The agent returned an unexpected shape.");
  }
  return {
    title: payload.title,
    sections: payload.sections ?? [],
    recommendation: payload.recommendation ?? "",
    riskFactors: (payload.risk_factors ?? []).map((f) => ({
      name: f.name,
      score: Number(f.score ?? 0),
      weight: Number(f.weight ?? 0),
      rationale: f.rationale ?? "",
    })),
  };
}

/** Is the agent process actually up? Used to decide whether to offer the chat. */
export async function checkJouleHealth() {
  if (!JOULE_BASE_URL) return false;
  try {
    await request(`${JOULE_BASE_URL}/health`, { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}
