import React, { useEffect, useRef, useState } from "react";
import { askJoule, checkJouleHealth, JOULE_ENABLED } from "../api/client.js";

/**
 * Joule · Risk Intelligence — a conversation, not a set of panels.
 *
 * Backed by the compliance agent (POST /api/joule/chat), which routes a question
 * to one of five AML skills, pulls the facts, and synthesises an answer.
 *
 * Behaves the way an analyst expects a chat to behave: what you asked appears
 * immediately as your own message, the agent answers beneath it, the log scrolls
 * to the newest turn, and the composer stays pinned at the bottom. Asking the
 * same thing twice asks it twice — nothing here toggles.
 *
 * Still true: no request is made until the analyst sends one. Opening a case
 * says nothing to the agent.
 */

const SUGGESTIONS = [
  { key: "explain", label: "Why was this flagged?", query: "Explain the risk score drivers for this alert." },
  { key: "case", label: "Assemble case file", query: "Assemble and draft the case file for this alert." },
  { key: "screen", label: "Screen the counterparty", query: "Run a sanctions, PEP and adverse media screening check on this counterparty." },
  { key: "queue", label: "What should I triage next?", query: "Show me the triage queue and what to prioritise." },
  { key: "aging", label: "Anything past SLA?", query: "Which cases are aging or past their escalation deadline?" },
];

function Report({ report }) {
  const factors = [...(report.riskFactors ?? [])].sort(
    (a, z) => z.score * z.weight - a.score * a.weight,
  );

  return (
    <>
      {report.title && <div className="ag-title">{report.title}</div>}

      {report.sections.map((section, i) => (
        <div key={i} className="ag-section">
          <div className="seclabel">{section.label}</div>
          <p>{section.content}</p>
        </div>
      ))}

      {factors.length > 0 && (
        <div className="agent-factors">
          <div className="seclabel">Risk factors</div>
          {factors.map((factor, i) => (
            <div className="frow agent-frow" key={i} title={factor.rationale}>
              <span className="fname">
                <span className="wbadge">{Math.round(factor.weight * 100)}%</span>
                {factor.name}
              </span>
              <span className="track">
                <span className="fill" style={{ width: `${Math.max(0, Math.min(100, factor.score))}%` }} />
              </span>
              <span className="ffig"><b>{Math.round(factor.score)}</b> / 100</span>
            </div>
          ))}
        </div>
      )}

      {report.recommendation && (
        <div className="agent-rec">
          <span className="reclabel">Recommendation</span>
          <p>{report.recommendation}</p>
        </div>
      )}
    </>
  );
}

export default function Assistant({ assessment }) {
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [agentUp, setAgentUp] = useState(null);

  const nextId = useRef(0);
  const logRef = useRef(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  /* Availability probe — not a query. Keeps retrying while the agent is down so
   * the panel enables itself once the service finishes starting. */
  useEffect(() => {
    if (!JOULE_ENABLED) {
      setAgentUp(false);
      return undefined;
    }
    let cancelled = false;
    let timer = null;
    const probe = async () => {
      const up = await checkJouleHealth();
      if (cancelled) return;
      setAgentUp(up);
      if (!up) timer = setTimeout(probe, 10000);
    };
    probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // A new case is a new conversation. No request is made for it.
  useEffect(() => {
    setEntries([]);
    setBusy(false);
    setInput("");
  }, [assessment.alertId, assessment.transactionId, assessment.assessmentId]);

  // Follow the conversation, the way every chat does.
  useEffect(() => {
    if (entries.length === 0) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    endRef.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "end" });
  }, [entries]);

  async function send(query) {
    const text = query.trim();
    if (!text || busy) return;

    const askId = ++nextId.current;
    setEntries((list) => [
      ...list,
      { id: askId, role: "user", text },
      { id: askId + 0.5, role: "agent", status: "pending" },
    ]);
    setBusy(true);

    try {
      const report = await askJoule(text, assessment);
      setEntries((list) =>
        list.map((e) => (e.id === askId + 0.5 ? { ...e, status: "done", report } : e)),
      );
    } catch (error) {
      setEntries((list) =>
        list.map((e) =>
          e.id === askId + 0.5 ? { ...e, status: "error", message: error.message } : e,
        ),
      );
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  const probing = agentUp === null;
  const unavailable = agentUp === false;
  const started = entries.length > 0;

  return (
    <aside className="assistant" aria-label="Risk intelligence assistant">
      <div className="chat-head">
        <span className={`joule-badge${unavailable ? " offline" : ""}`}>
          <span className="pulse" aria-hidden="true" />
          Joule · Risk Intelligence
        </span>
        <h2>Assistant</h2>
      </div>

      <div className="chat-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {probing && (
          <p className="chat-note">Checking whether the compliance agent is available…</p>
        )}

        {unavailable && (
          <p className="chat-note">
            The compliance agent isn't reachable. Start the Python service — this panel
            will enable itself once it answers.
          </p>
        )}

        {agentUp === true && !started && (
          <div className="chat-empty">
            <p className="chat-note">
              Ask about {assessment.alertId ?? `transaction ${assessment.transactionId}`}.
              Nothing is generated until you send something.
            </p>
            <div className="chip-row">
              {SUGGESTIONS.map((sug) => (
                <button
                  key={sug.key}
                  type="button"
                  className="chip"
                  onClick={() => send(sug.query)}
                >
                  {sug.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((entry) =>
          entry.role === "user" ? (
            <div className="turn user" key={entry.id}>
              <div className="bubble-user">{entry.text}</div>
            </div>
          ) : (
            <div className="turn agent" key={entry.id}>
              <div className="bubble-agent">
                <div className="ag-head">
                  <span aria-hidden="true">◇</span>
                  Joule
                  <span className="src">
                    {entry.status === "pending"
                      ? "thinking"
                      : entry.status === "error"
                        ? "unavailable"
                        : "gpt-4o"}
                  </span>
                </div>
                {entry.status === "pending" && (
                  <div className="typing" aria-label="Thinking">
                    <span /><span /><span />
                  </div>
                )}
                {entry.status === "error" && <p className="agent-error">{entry.message}</p>}
                {entry.status === "done" && <Report report={entry.report} />}
              </div>
            </div>
          ),
        )}

        <div ref={endRef} />
      </div>

      {agentUp === true && (
        <div className="chat-foot">
          {started && (
            <div className="chip-row compact">
              {SUGGESTIONS.map((sug) => (
                <button
                  key={sug.key}
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => send(sug.query)}
                >
                  {sug.label}
                </button>
              ))}
            </div>
          )}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              const text = input;
              setInput("");
              send(text);
            }}
          >
            <input
              ref={inputRef}
              type="text"
              className="askinput"
              placeholder={busy ? "Waiting for a reply…" : "Ask about this case…"}
              aria-label="Message the compliance agent"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={busy}
            />
            <button type="submit" className="btn btn-primary asksend" disabled={busy || !input.trim()}>
              Send
            </button>
          </form>

          <p className="chat-foot-note">
            Decision support only — a human reviews and approves every action.
          </p>
        </div>
      )}
    </aside>
  );
}
