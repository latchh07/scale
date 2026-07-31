/**
 * Diagnose why every corridor renders as same-country.
 *
 * Prints the columns available on TRANSACTIONS and COMPANIES, then samples real
 * rows and shows which candidate column pairs actually produce a cross-border
 * corridor. Read-only — it selects and nothing else.
 *
 *   npm run describe:corridor
 */

import hanaClient from "@sap/hana-client";

const SCHEMA = process.env.HANA_SCHEMA ?? "TEAM_12";

for (const name of ["HANA_HOST", "HANA_PORT", "HANA_USER", "HANA_PASSWORD"]) {
  if (!process.env[name]) {
    console.error(`${name} is not set. Run: npm run preflight`);
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

const connection = await connect();
try {
  console.log(`\nCorridor diagnosis — ${SCHEMA}\n${"═".repeat(70)}`);

  for (const table of ["TRANSACTIONS", "COMPANIES", "COUNTRIES"]) {
    const cols = await query(
      connection,
      `SELECT COLUMN_NAME AS "c", DATA_TYPE_NAME AS "t" FROM SYS.TABLE_COLUMNS
       WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? ORDER BY POSITION`,
      [SCHEMA.toUpperCase(), table],
    );
    console.log(`\n${table} (${cols.length} columns)`);
    console.log("  " + cols.map((r) => r.c ?? r.COLUMN_NAME).join(", "));
  }

  // Anything that smells like a country or party reference.
  const txCols = (
    await query(
      connection,
      `SELECT COLUMN_NAME AS "c" FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = 'TRANSACTIONS'`,
      [SCHEMA.toUpperCase()],
    )
  ).map((r) => r.c ?? r.COLUMN_NAME);

  const countryish = txCols.filter((c) => /COUNTRY|CORRIDOR|ORIGIN|DEST|SOURCE|BENEFICIAR/i.test(c));
  console.log(`\n${"═".repeat(70)}`);
  console.log(`Country / party columns on TRANSACTIONS:\n  ${countryish.join(", ") || "none found"}`);

  if (countryish.length > 0) {
    const sample = await query(
      connection,
      `SELECT TOP 8 "TRANSACTION_ID" AS "id", ${countryish.map((c) => `"${c}"`).join(", ")}
       FROM "${SCHEMA}"."TRANSACTIONS"`,
    );
    console.log(`\nSample rows:`);
    for (const row of sample) {
      const parts = countryish.map((c) => `${c}=${row[c] ?? "null"}`);
      console.log(`  txn ${row.id}: ${parts.join("  ")}`);
    }
  }

  // The actual question: does the originator's country ever differ from the
  // destination, using the columns transaction-detail.js currently joins on?
  const companyCols = (
    await query(
      connection,
      `SELECT COLUMN_NAME AS "c" FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = 'COMPANIES'`,
      [SCHEMA.toUpperCase()],
    )
  ).map((r) => r.c ?? r.COLUMN_NAME);
  const companyCountry = ["COUNTRY_ID", "HEADQUARTERS_COUNTRY_ID", "HQ_COUNTRY_ID", "DOMICILE_COUNTRY_ID"]
    .find((c) => companyCols.includes(c));

  console.log(`\n${"═".repeat(70)}`);
  console.log(`COMPANIES country column in use: ${companyCountry ?? "none found"}`);

  if (companyCountry && txCols.includes("DESTINATION_COUNTRY_ID")) {
    const [row] = await query(
      connection,
      `SELECT
         COUNT(*) AS "total",
         SUM(CASE WHEN C."${companyCountry}" = T."DESTINATION_COUNTRY_ID" THEN 1 ELSE 0 END) AS "same"
       FROM "${SCHEMA}"."TRANSACTIONS" T
       JOIN "${SCHEMA}"."COMPANIES" C ON C."COMPANY_ID" = T."ORIGINATOR_COMPANY_ID"`,
    );
    const total = Number(row.total ?? row.TOTAL);
    const same = Number(row.same ?? row.SAME);
    const pct = total ? ((same / total) * 100).toFixed(1) : "0";
    console.log(`\nOriginator country == DESTINATION_COUNTRY_ID for ${same}/${total} rows (${pct}%)`);
    console.log(
      pct > 90
        ? "  -> These two columns are effectively the same value. DESTINATION_COUNTRY_ID\n" +
          "     is not the beneficiary's country; the corridor needs a different source."
        : "  -> The columns differ, so the data really does contain domestic payments.",
    );
  }

  // Is the beneficiary's country the better destination?
  if (txCols.includes("BENEFICIARY_COMPANY_ID") && companyCountry) {
    const [row] = await query(
      connection,
      `SELECT
         COUNT(*) AS "total",
         SUM(CASE WHEN OC."${companyCountry}" = BC."${companyCountry}" THEN 1 ELSE 0 END) AS "same"
       FROM "${SCHEMA}"."TRANSACTIONS" T
       JOIN "${SCHEMA}"."COMPANIES" OC ON OC."COMPANY_ID" = T."ORIGINATOR_COMPANY_ID"
       JOIN "${SCHEMA}"."COMPANIES" BC ON BC."COMPANY_ID" = T."BENEFICIARY_COMPANY_ID"`,
    );
    const total = Number(row.total ?? row.TOTAL);
    const same = Number(row.same ?? row.SAME);
    const pct = total ? ((same / total) * 100).toFixed(1) : "0";
    console.log(`\nUsing the BENEFICIARY company's country instead:`);
    console.log(`  same-country for ${same}/${total} rows (${pct}%)`);
    console.log(
      pct < 90
        ? "  -> This produces real cross-border corridors. Use this as the destination."
        : "  -> Still mostly domestic; the dataset may genuinely be domestic-heavy.",
    );
  }
  console.log("");
} catch (error) {
  console.error(`\nQuery failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  connection.disconnect(() => {});
}
