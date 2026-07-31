import React, { useCallback, useEffect, useRef, useState } from "react";

import Masthead from "./components/Masthead.jsx";
import QueueRail from "./components/QueueRail.jsx";
import CasePanel from "./components/CasePanel.jsx";
import Assistant from "./components/Assistant.jsx";
import DegradationBanner from "./components/DegradationBanner.jsx";
import ResolutionBar from "./components/ResolutionBar.jsx";
import {
  API_BASE_URL,
  POLL_INTERVAL_MS,
  hydrateAll,
  loadDemoQueue,
  loadQueue,
  pollForNewAlerts,
} from "./api/client.js";
import { alertKey, sortByExposure } from "./lib/transform.js";

/** TrustSphere's annual alert volume, per the SCALE 2026 business case. */
const TOTAL_POOL = "12,000";

/** How long a newly arrived alert stays highlighted in the queue. */
const NEW_ALERT_TTL_MS = 12000;

export default function App() {
  const [state, setState] = useState({ status: "loading", alerts: [], mode: "demo", health: null });
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [newIds, setNewIds] = useState(() => new Set());
  const [resolution, setResolution] = useState(null);
  /* Alerts the analyst has decided on. Held in a ref as well as being removed
   * from state, because the poll compares against the live list — without this
   * a resolved alert would look "new" on the next tick and come straight back. */
  const resolvedRef = useRef(new Set());
  const [lastPoll, setLastPoll] = useState(null);
  const caseRef = useRef(null);

  const applyQueue = useCallback((result) => {
    const alerts = sortByExposure(result.alerts);
    setState({
      status: "ready",
      alerts,
      mode: result.mode,
      source: result.source,
      health: result.health,
      errors: result.errors ?? [],
      fault: result.fault ?? null,
      summaries: result.summaries ?? null,
      clearedCount: result.clearedCount ?? 0,
    });
    setNewIds(new Set());
    setSelectedId((current) => {
      const stillThere = alerts.some((a) => alertKey(a) === current);
      return stillThere ? current : (alerts[0] ? alertKey(alerts[0]) : null);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, status: "loading" }));
    loadQueue()
      .then((result) => {
        if (!cancelled) applyQueue(result);
      })
      .catch((error) => {
        if (!cancelled) setState({ status: "error", alerts: [], mode: "demo", health: null, error: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [applyQueue]);

  /* ---- Live feed -------------------------------------------------------
   * Poll /history for assessments that appeared since the last check. New
   * alerts are merged in at their ranked position and briefly highlighted,
   * so a simulated transaction visibly lands in the queue.
   *
   * The current alert list is held in a ref rather than read from the effect
   * closure. That keeps the interval stable (no teardown on every merge) and,
   * combined with the de-duplicating functional update below, makes the merge
   * idempotent — two overlapping ticks cannot insert the same alert twice.
   * -------------------------------------------------------------------- */
  const live = state.status === "ready" && state.mode === "live" && state.source === "history";

  /* ---- Background detail ----------------------------------------------
   * The queue renders from the summary list after one request. Full records
   * are fetched a few at a time and merged in as they arrive, so a slow HANA
   * connection delays detail rather than the whole dashboard.
   * -------------------------------------------------------------------- */
  useEffect(() => {
    if (!live || !state.summaries) return undefined;
    let cancelled = false;

    // Fetch the case that is on screen first.
    const ordered = [...state.summaries].sort((a, z) => {
      const aSel = a.assessmentId === selectedId ? -1 : 0;
      const zSel = z.assessmentId === selectedId ? -1 : 0;
      return aSel - zSel;
    });

    hydrateAll(ordered, (record) => {
      if (cancelled || !record.detailAvailable) return;
      if (resolvedRef.current.has(alertKey(record))) return;
      setState((s) => ({
        ...s,
        alerts: s.alerts.map((a) => (alertKey(a) === alertKey(record) ? record : a)),
      }));
    }).then(() => {
      if (!cancelled) setState((s) => ({ ...s, summaries: null }));
    });

    return () => {
      cancelled = true;
    };
    // Runs once per queue load; selectedId is only used for ordering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, state.summaries]);

  const alertsRef = useRef([]);
  useEffect(() => {
    alertsRef.current = state.alerts;
  }, [state.alerts]);

  useEffect(() => {
    if (!live) return undefined;
    let cancelled = false;

    const tick = async () => {
      try {
        const known = new Set(alertsRef.current.map((a) => a.assessmentId).filter(Boolean));
        const { alerts: fresh, fault } = await pollForNewAlerts(known);
        if (cancelled) return;
        setLastPoll(new Date());
        // A fault raised mid-session is shown; a clean tick clears it.
        setState((s) => (s.fault === fault || (!s.fault && !fault) ? s : { ...s, fault }));
        if (fresh.length === 0) return;

        // Decide what is genuinely new against the current list (held in the
        // ref), then merge with a second guard inside the updater. No side
        // effects live in the updater itself — React may call it lazily.
        const seen = new Set(alertsRef.current.map((a) => alertKey(a)));
        const additions = fresh.filter(
          (a) => !seen.has(alertKey(a)) && !resolvedRef.current.has(alertKey(a)),
        );
        if (additions.length === 0) return;
        const added = additions.map((a) => alertKey(a));

        setState((s) => {
          const current = new Set(s.alerts.map((a) => alertKey(a)));
          const merged = additions.filter((a) => !current.has(alertKey(a)));
          if (merged.length === 0) return s;
          return { ...s, alerts: sortByExposure([...merged, ...s.alerts]) };
        });

        setNewIds((prev) => new Set([...prev, ...added]));
        setTimeout(() => {
          if (cancelled) return;
          setNewIds((prev) => {
            const next = new Set(prev);
            added.forEach((id) => next.delete(id));
            return next;
          });
        }, NEW_ALERT_TTL_MS);
      } catch {
        // Unexpected failure — the next tick retries.
      }
    };

    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live]);

  /* ---- Analyst decision ------------------------------------------------
   * Approve releases the payment, Decline blocks it. Both remove the alert
   * from the queue and move to the next one. Undo restores it.
   * -------------------------------------------------------------------- */
  const resolveCase = (assessment, decision) => {
    const key = alertKey(assessment);
    if (!key) return;
    resolvedRef.current.add(key);

    setState((s) => {
      const index = s.alerts.findIndex((a) => alertKey(a) === key);
      const remaining = s.alerts.filter((a) => alertKey(a) !== key);
      // Land on the next case down the queue, or the last one if we were at the end.
      const next = remaining[Math.min(index, remaining.length - 1)];
      setSelectedId(next ? alertKey(next) : null);
      return { ...s, alerts: remaining };
    });

    setResolution({
      key,
      decision,
      alertId: assessment.alertId,
      transactionId: assessment.transactionId,
      alert: assessment,
      index: state.alerts.findIndex((a) => alertKey(a) === key),
    });
  };

  const undoResolution = () => {
    if (!resolution) return;
    resolvedRef.current.delete(resolution.key);
    setState((s) => ({ ...s, alerts: sortByExposure([resolution.alert, ...s.alerts]) }));
    setSelectedId(resolution.key);
    setResolution(null);
  };

  // The confirmation is transient; the removal is not.
  useEffect(() => {
    if (!resolution) return undefined;
    const timer = setTimeout(() => setResolution(null), 10000);
    return () => clearTimeout(timer);
  }, [resolution]);

  const toggleMode = async () => {
    if (state.mode === "live") {
      applyQueue(loadDemoQueue());
      return;
    }
    setState((s) => ({ ...s, status: "loading" }));
    applyQueue(await loadQueue());
  };

  const selectCase = (id) => {
    setSelectedId(id);
    if (window.matchMedia?.("(max-width:820px)")?.matches) {
      caseRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const selected = state.alerts.find((a) => alertKey(a) === selectedId) ?? state.alerts[0];

  return (
    <>
      <a href="#case" className="skip">Skip to selected case</a>

      <Masthead
        mode={state.mode}
        health={state.health}
        onToggleMode={toggleMode}
        busy={state.status === "loading"}
        live={live}
        lastPoll={lastPoll}
      />

      <DegradationBanner fault={state.fault} showingDemoData={state.mode === "demo"} />

      <ResolutionBar
        resolution={resolution}
        onUndo={undoResolution}
        onDismiss={() => setResolution(null)}
      />

      <main className="workbench">
        {state.status === "loading" && (
          <>
            <nav className="queue" aria-label="Alert triage queue">
              <span className="eyebrow">Triage queue</span>
              <div className="queue-head"><h2>Alerts by exposure</h2></div>
              <p className="queue-sub">Contacting the risk API…</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="skeleton" style={{ height: 64, borderRadius: 12 }} />
                ))}
              </div>
            </nav>
            <section className="case" id="case" tabIndex={-1}>
              <div className="state">
                <span className="eyebrow">Loading</span>
                <h3>Assessing transactions</h3>
                <p>
                  Each alert is a full round trip: HANA context → behavioural features →
                  SAP AI Core → policy engine.
                </p>
              </div>
            </section>
            <aside className="assistant" aria-label="Risk intelligence assistant">
              <span className="joule-badge"><span className="pulse" aria-hidden="true" />Joule · Risk Intelligence</span>
              <h2>Assistant</h2>
              <p className="asub">Waiting for a case.</p>
            </aside>
          </>
        )}

        {state.status === "error" && (
          <section className="case" id="case" tabIndex={-1} style={{ gridColumn: "1 / -1" }}>
            <div className="state">
              <span className="eyebrow">Unavailable</span>
              <h3>Could not load the triage queue</h3>
              <p>{state.error}</p>
              <p>
                Start the backend with <code>npm start</code> in <code>scale/backend</code>,
                then confirm <code>{API_BASE_URL}/health</code> responds.
              </p>
            </div>
          </section>
        )}

        {state.status === "ready" && state.alerts.length === 0 && (
          <section className="case" id="case" tabIndex={-1} style={{ gridColumn: "1 / -1" }}>
            <div className="state">
              <span className="eyebrow">Queue clear</span>
              <h3>Every alert has been actioned</h3>
              <p>Nothing is waiting for review. New assessments will appear here as they arrive.</p>
            </div>
          </section>
        )}

        {state.status === "ready" && selected && (
          <>
            <QueueRail
              alerts={state.alerts}
              selectedId={alertKey(selected)}
              onSelect={selectCase}
              filter={filter}
              onFilter={setFilter}
              totalPool={TOTAL_POOL}
              newIds={newIds}
              live={live}
              clearedCount={state.clearedCount}
            />
            <CasePanel
              key={alertKey(selected)}
              assessment={selected}
              caseRef={caseRef}
              onResolve={resolveCase}
            />
            <Assistant key={`assistant-${alertKey(selected)}`} assessment={selected} />
          </>
        )}
      </main>
    </>
  );
}
