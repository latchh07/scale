import React from "react";
import TierChip from "./TierChip.jsx";
import {
  TIER_FILTERS,
  actionLabel,
  alertKey,
  filterByTier,
  formatAmount,
  sortByExposure,
  tierOf,
} from "../lib/transform.js";

/**
 * Triage queue. Ranked by the backend's overallScore rather than a
 * frontend-side composite — the frontend never recalculates a score.
 *
 * When the queue is backed by /history, newly persisted assessments arrive on
 * a poll and are briefly highlighted so an incoming transaction is visible.
 */
export default function QueueRail({
  alerts,
  selectedId,
  onSelect,
  filter,
  onFilter,
  totalPool,
  newIds,
  live,
  clearedCount = 0,
}) {
  const rows = filterByTier(sortByExposure(alerts), filter);

  return (
    <nav className="queue" aria-label="Alert triage queue">
      <span className="eyebrow">Triage queue</span>
      <div className="queue-head">
        <h2>Alerts by exposure</h2>
      </div>
      <p className="queue-sub">
        <b>{rows.length}</b> of {totalPool} alerts · ranked by regulatory exposure &amp; investigator effort
      </p>

      <div className="filters" role="group" aria-label="Filter by priority tier">
        {TIER_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className="pill"
            aria-pressed={filter === f}
            onClick={() => onFilter(f)}
          >
            {f === "all" ? "All" : f}
          </button>
        ))}
      </div>

      <ul className="qlist">
        {rows.map((a) => {
          const key = alertKey(a);
          const tier = tierOf(a.assessment?.riskLevel);
          const score = Math.round(Number(a.assessment?.overallScore ?? 0));
          const amount = formatAmount(a.transaction);
          const corridor =
            a.transaction?.originatorCountry && a.transaction?.destinationCountry
              ? `${a.transaction.originatorCountry} → ${a.transaction.destinationCountry}${
                  a.transaction.crossBorder === false ? " (domestic)" : ""
                }`
              : `Transaction ${a.transactionId}`;
          const product = a.transaction?.productType ?? "Cross-border payment";
          const ruleCount = (a.rulesTriggered ?? []).length;
          const isNew = newIds?.has(key);

          return (
            <li key={key}>
              <button
                type="button"
                className={`qrow${isNew ? " is-new" : ""}`}
                style={{ "--tier": tier.color }}
                aria-current={key === selectedId}
                aria-label={`${a.alertId ?? a.transactionId}, ${tier.name} priority, score ${score}. ${product}, ${corridor}.${isNew ? " Newly received." : ""}`}
                onClick={() => onSelect(key)}
              >
                <span className="qscore" aria-hidden="true">{score}</span>
                <span className="qmeta">
                  <span className="qtop">
                    <span className="qid">{a.alertId ?? `TXN-${a.transactionId}`}</span>
                    <TierChip riskLevel={a.assessment?.riskLevel} />
                    {a.assessment?.hardOverride && <span className="ovr-mark">Override</span>}
                    {isNew && <span className="new-mark">New</span>}
                  </span>
                  <span className="qdesc">{product} · {corridor}</span>
                  <span className="qfoot">
                    {amount ? `${amount} · ` : ""}
                    {a.detailAvailable === false
                      ? ""
                      : `${ruleCount} rule${ruleCount === 1 ? "" : "s"} · `}
                    {actionLabel(a.assessment?.recommendedAction)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {rows.length === 0 && <p className="ledger-empty">No alerts in this tier.</p>}

      {clearedCount > 0 && (
        <p className="cleared-note">
          {clearedCount} assessed and scored 0 — no rule or model signal, so not queued.
        </p>
      )}

      {live && (
        <p className="feed-note">
          <span className="lamp" aria-hidden="true" />
          Live feed · new assessments appear automatically
        </p>
      )}
    </nav>
  );
}
