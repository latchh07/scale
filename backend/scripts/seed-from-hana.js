/**
 * Fill the triage queue with REAL transactions from SAP HANA.
 *
 * Reads the bank's own alert table (TEAM_12.RISK_ALERTS), takes the
 * TRANSACTION_ID from each alert, and asks the running backend to assess it via
 * POST /api/risk-assessments/from-transaction. That route pulls the transaction
 * and its KYC / ownership / country context out of HANA, derives the nine
 * behavioural features from the originator's prior transactions, calls SAP AI
 * Core, applies the policy, and persists the result.
 *
 * Nothing here computes a score. This script only decides WHICH transactions to
 * assess; every number comes from the backend.
 *
 * Usage
 *   npm run seed:hana                        20 alerts, real ALERT_IDs
 *   npm run seed:hana -- --count 50
 *   npm run seed:hana -- --source amount     highest-value transactions instead
 *   npm run seed:hana -- --source random     random spread
 *   npm run seed:hana -- --dry-run           list what it would assess
 *   npm run seed:hana -- --cross-border      only cross-border payments
 */

import hanaClient from "@sap/hana-client";

const API_BASE_URL = (process.env.RISK_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SCHEMA = process.env.HANA_SCHEMA ?? "TEAM_12";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const options = {
  count: Math.min(Math.max(Number(value("count", 20)), 1), 200),
  source: value("source", "alerts"),
  dryRun: flag("dry-run"),
  crossBorder: flag("cross-border"),
  concurrency: Number(value("concurrency", 4)),
};

if (!["alerts", "amount", "random"].includes(options.source)) {
  console.error(`--source must be one of: alerts, amount, random`);
  process.exit(1);
}

for (const name of ["HANA_HOST", "HANA_PORT", "HANA_USER", "HANA_PASSWORD"]) {
  if (!process.env[name]) {
    console.error(`${name} is not set. Put credentials in team_12.env at the repo root, then re-run.`);
    console.error(`Tip: npm run preflight  tells you exactly what is missing.`);
    process.exit(1);
  }
}

function connect() {
  const connection = hanaClient.createConnection();
  return new Promise((resolve, reject) => {
    connection.connect(
      {
        host: process.env.HANA_HOST,
        port: Number(process.env.HANA_PORT),
        uid: process.env.HANA_USER,
        pwd: process.env.HANA_PASSWORD,
        encrypt: true,
        sslValidateCertificate: process.env.HANA_SSL_VALIDATE_CERTIFICATE === "true",
      },
      (error) => (error ? reject(error) : resolve(connection)),
    );
  });
}

const query = (connection, sql, params = []) =>
  new Promise((resolve, reject) =>
    connection.exec(sql, params, (error, rows) => (error ? reject(error) : resolve(rows ?? []))),
  );

// ~88% of TEAM_12.TRANSACTIONS are domestic. --cross-border restricts the
// selection to the bank's actual line of business. It narrows which rows are
// assessed; it does not change how any of them are scored.
const crossBorderClause = options.crossBorder ? `AND T."IS_CROSS_BORDER" = 'TRUE'` : "";

const SELECTORS = {
  // The bank's own alert queue: real ALERT_IDs paired with real transactions.
  alerts: `
    SELECT TOP ${options.count}
      A."ALERT_ID" AS "alertId",
      A."TRANSACTION_ID" AS "transactionId",
      A."ALERT_TYPE" AS "alertType",
      A."ALERT_PRIORITY" AS "priority"
    FROM "${SCHEMA}"."RISK_ALERTS" A
    JOIN "${SCHEMA}"."TRANSACTIONS" T ON T."TRANSACTION_ID" = A."TRANSACTION_ID"
    WHERE A."TRANSACTION_ID" IS NOT NULL
    ${crossBorderClause}
    ORDER BY A."CREATED_AT" DESC`,
  amount: `
    SELECT TOP ${options.count}
      NULL AS "alertId",
      T."TRANSACTION_ID" AS "transactionId",
      'HIGH_VALUE' AS "alertType",
      NULL AS "priority"
    FROM "${SCHEMA}"."TRANSACTIONS" T
    ${options.crossBorder ? `WHERE T."IS_CROSS_BORDER" = 'TRUE'` : ""}
    ORDER BY T."AMOUNT_USD" DESC`,
  random: `
    SELECT TOP ${options.count}
      NULL AS "alertId",
      T."TRANSACTION_ID" AS "transactionId",
      'SAMPLE' AS "alertType",
      NULL AS "priority"
    FROM "${SCHEMA}"."TRANSACTIONS" T
    ${options.crossBorder ? `WHERE T."IS_CROSS_BORDER" = 'TRUE'` : ""}
    ORDER BY RAND()`,
};

async function assess({ transactionId, alertId }) {
  const response = await fetch(`${API_BASE_URL}/api/risk-assessments/from-transaction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transactionId: String(transactionId),
      ...(alertId ? { alertId: String(alertId) } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.details ?? payload.error ?? `HTTP ${response.status}`;
    throw Object.assign(new Error(detail), { status: response.status });
  }
  return payload;
}

/* ------------------------------------------------------------------ run --- */

console.log(
  `\nSeeding the queue from ${SCHEMA} (source: ${options.source}` +
    `${options.crossBorder ? ", cross-border only" : ""})\n` + "─".repeat(78),
);

let rows;
let connection;
try {
  connection = await connect();
} catch (error) {
  console.error(`Could not connect to SAP HANA: ${error.message}`);
  console.error(`Tip: npm run preflight`);
  process.exit(1);
}
try {
  rows = await query(connection, SELECTORS[options.source]);
} catch (error) {
  console.error(`Could not read ${SCHEMA}: ${error.message}`);
  console.error(`Tip: npm run preflight`);
  process.exit(1);
} finally {
  connection.disconnect(() => {});
}

if (rows.length === 0) {
  console.error(`No rows returned. Is ${SCHEMA}.RISK_ALERTS populated? Try --source amount.`);
  process.exit(1);
}
console.log(`Selected ${rows.length} transaction(s) from HANA.\n`);

if (options.dryRun) {
  rows.forEach((r) => console.log(`  ${r.alertId ?? "(no alert)"}  txn ${r.transactionId}  ${r.alertType ?? ""}`));
  console.log(`\nDry run — nothing was assessed.\n`);
  process.exit(0);
}

console.log("alert            txn        score risk      composition");
console.log("─".repeat(78));

let ok = 0;
const failures = [];
const queue = [...rows];

async function worker() {
  while (queue.length > 0) {
    const row = queue.shift();
    try {
      const r = await assess(row);
      ok += 1;
      const b = r.scoreBreakdown ?? {};
      const anomaly = b.anomalyAvailable ? String(b.anomalyScore) : "n/a";
      console.log(
        `${String(r.alertId ?? "—").padEnd(16)} ${String(r.transactionId).padEnd(10)} ` +
          `${String(r.assessment.overallScore).padStart(3)}  ${r.assessment.riskLevel.padEnd(9)} ` +
          `rules ${String(b.ruleScore).padStart(3)} · anomaly ${anomaly.padStart(3)}` +
          `${r.assessment.hardOverride ? "  OVERRIDE" : ""}` +
          `${r.caseId ? `  case ${r.caseId}` : ""}`,
      );
    } catch (error) {
      failures.push({ transactionId: row.transactionId, message: error.message, status: error.status });
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));

console.log("─".repeat(78));
console.log(`${ok} assessed and persisted, ${failures.length} failed.`);

if (failures.length > 0) {
  const sample = failures.slice(0, 3);
  console.log("\nFirst failures:");
  sample.forEach((f) => console.log(`  txn ${f.transactionId}: ${f.message}`));
  if (failures.some((f) => f.status === 503)) {
    console.log(
      "\n  503 means the score was computed but the HANA write failed, and this\n" +
        "  backend discards it. Run: npm run preflight",
    );
  }
}
if (ok > 0) console.log(`\nOpen the dashboard — the queue should now show real HANA alerts.\n`);
