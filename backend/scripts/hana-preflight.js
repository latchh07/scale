/**
 * One command that says exactly which link in the chain is broken.
 *
 * Run before anything else when the dashboard will not show live data:
 *   npm run preflight
 *
 * It checks, in order: credentials present -> connection -> source schema ->
 * source tables -> write schema -> assessment table -> row counts. It stops at
 * the first failure and prints the fix for that specific step, rather than
 * leaving you to guess from a driver stack trace.
 */

import hanaClient from "@sap/hana-client";

const SOURCE_SCHEMA = process.env.HANA_SCHEMA ?? "TEAM_12";
const WRITE_SCHEMA = process.env.HANA_WRITE_SCHEMA ?? process.env.HANA_USER ?? "TEAM_12_USER";

const REQUIRED = ["HANA_HOST", "HANA_PORT", "HANA_USER", "HANA_PASSWORD"];
const SOURCE_TABLES = [
  "TRANSACTIONS",
  "COMPANIES",
  "COUNTRIES",
  "INDUSTRIES",
  "COMPANY_BENEFICIAL_OWNERS",
  "RISK_ALERTS",
];

const pass = (m) => console.log(`  ok    ${m}`);
const fail = (m, fix) => {
  console.log(`  FAIL  ${m}`);
  if (fix) console.log(`\n  Fix: ${fix}\n`);
};

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

console.log("\nSAP HANA preflight\n" + "─".repeat(52));

const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length > 0) {
  fail(
    `credentials missing: ${missing.join(", ")}`,
    "Put them in team_12.env at the repo root, or backend/.env. The npm scripts load both.",
  );
  process.exit(1);
}
pass(`credentials present (host ${process.env.HANA_HOST?.slice(0, 12)}…, user ${process.env.HANA_USER})`);

let connection;
try {
  connection = await connect();
  pass("connected to SAP HANA Cloud");
} catch (error) {
  fail(`connection refused — ${error.message}`, "Check the host/port and that your IP is allowed by the HANA instance.");
  process.exit(1);
}

try {
  const found = await query(
    connection,
    `SELECT TABLE_NAME AS "name" FROM SYS.TABLES WHERE SCHEMA_NAME = ?`,
    [SOURCE_SCHEMA.toUpperCase()],
  );
  const names = new Set(found.map((r) => r.name ?? r.TABLE_NAME));
  if (names.size === 0) {
    fail(`source schema ${SOURCE_SCHEMA} is empty or not visible`, `Check HANA_SCHEMA. Expected ${SOURCE_SCHEMA}.`);
    process.exit(1);
  }
  pass(`source schema ${SOURCE_SCHEMA} visible (${names.size} tables)`);

  const absent = SOURCE_TABLES.filter((t) => !names.has(t));
  if (absent.length > 0) console.log(`  warn  missing expected tables: ${absent.join(", ")}`);
  else pass(`all expected source tables present`);

  for (const table of ["TRANSACTIONS", "RISK_ALERTS"]) {
    if (!names.has(table)) continue;
    const [row] = await query(connection, `SELECT COUNT(*) AS "n" FROM "${SOURCE_SCHEMA}"."${table}"`);
    pass(`${SOURCE_SCHEMA}.${table}: ${Number(row.n ?? row.N).toLocaleString()} rows`);
  }

  // Which descriptive columns exist decides whether the dashboard can show
  // Amount / Corridor / Client, or only IDs.
  const columnRows = await query(
    connection,
    `SELECT TABLE_NAME AS "t", COLUMN_NAME AS "c" FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ?`,
    [SOURCE_SCHEMA.toUpperCase()],
  );
  const byTable = new Map();
  for (const row of columnRows) {
    const t = row.t ?? row.TABLE_NAME;
    const c = row.c ?? row.COLUMN_NAME;
    if (!byTable.has(t)) byTable.set(t, new Set());
    byTable.get(t).add(c);
  }
  const pick = (table, candidates) => candidates.find((c) => byTable.get(table)?.has(c)) ?? null;
  const descriptive = {
    "company name": pick("COMPANIES", ["COMPANY_NAME", "LEGAL_NAME", "REGISTERED_NAME", "COMPANY_LEGAL_NAME", "NAME"]),
    "company country": pick("COMPANIES", ["COUNTRY_ID", "HEADQUARTERS_COUNTRY_ID", "HQ_COUNTRY_ID", "DOMICILE_COUNTRY_ID", "INCORPORATION_COUNTRY_ID", "REGISTRATION_COUNTRY_ID"]),
    "country name": pick("COUNTRIES", ["COUNTRY_NAME", "NAME"]),
    "product type": pick("TRANSACTIONS", ["TRANSACTION_TYPE", "PRODUCT_TYPE", "PAYMENT_TYPE", "CHANNEL", "TYPE"]),
    "currency": pick("TRANSACTIONS", ["CURRENCY_ORIGINAL", "CURRENCY", "CURRENCY_CODE"]),
  };
  const resolved = Object.entries(descriptive).filter(([, v]) => v);
  const unresolved = Object.entries(descriptive).filter(([, v]) => !v).map(([k]) => k);
  pass(`descriptive columns resolved: ${resolved.map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  if (unresolved.length > 0) {
    console.log(`  warn  not found: ${unresolved.join(", ")} — those fields fall back to IDs in the dashboard`);
  }

  const store = await query(
    connection,
    `SELECT COUNT(*) AS "n" FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME = 'RISK_ASSESSMENTS'`,
    [WRITE_SCHEMA.toUpperCase()],
  );
  if (Number(store[0].n ?? store[0].N) === 0) {
    fail(
      `${WRITE_SCHEMA}.RISK_ASSESSMENTS does not exist`,
      "Run: npm run setup:assessment-store",
    );
    process.exit(1);
  }
  pass(`${WRITE_SCHEMA}.RISK_ASSESSMENTS exists`);

  const [saved] = await query(connection, `SELECT COUNT(*) AS "n" FROM "${WRITE_SCHEMA}"."RISK_ASSESSMENTS"`);
  const count = Number(saved.n ?? saved.N);
  if (count === 0) {
    console.log(`  warn  no assessments stored yet — the dashboard queue will be empty`);
    console.log(`\n  Next: npm run seed:hana -- --count 20\n`);
  } else {
    pass(`${count} assessment(s) stored — the dashboard has data to show`);
    console.log("");
  }
} finally {
  connection.disconnect(() => {});
}
