import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import hana from "@sap/hana-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", "team_12.env") });

const transactionIds = [5001, 888124];
const executePurge = process.argv.includes("--execute");
const schemas = [
  ...new Set([
    process.env.HANA_SCHEMA ?? "TEAM_12",
    process.env.HANA_WRITE_SCHEMA ?? process.env.HANA_USER ?? "TEAM_12_USER",
  ]),
].map((schema) => schema.toUpperCase());

const connection = hana.createConnection();
const connect = () =>
  new Promise((resolve, reject) => {
    connection.connect(
      {
        host: process.env.HANA_HOST,
        port: Number(process.env.HANA_PORT),
        uid: process.env.HANA_USER,
        pwd: process.env.HANA_PASSWORD,
        encrypt: true,
        sslValidateCertificate: process.env.HANA_SSL_VALIDATE_CERTIFICATE === "true",
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
const query = (sql, parameters = []) =>
  new Promise((resolve, reject) => {
    connection.exec(sql, parameters, (error, rows) =>
      error ? reject(error) : resolve(rows ?? []),
    );
  });
const disconnect = () =>
  new Promise((resolve) => connection.disconnect(() => resolve()));

await connect();
try {
  const schemaPlaceholders = schemas.map(() => "?").join(", ");
  const tables = await query(
    `SELECT C.SCHEMA_NAME, C.TABLE_NAME
       FROM SYS.TABLE_COLUMNS C
       JOIN SYS.TABLES T
         ON T.SCHEMA_NAME = C.SCHEMA_NAME
        AND T.TABLE_NAME = C.TABLE_NAME
      WHERE C.COLUMN_NAME = ?
        AND C.SCHEMA_NAME IN (${schemaPlaceholders})
      ORDER BY C.SCHEMA_NAME, C.TABLE_NAME`,
    ["TRANSACTION_ID", ...schemas],
  );

  const idPlaceholders = transactionIds.map(() => "?").join(", ");
  const matches = [];
  for (const tableRow of tables) {
    const schema = tableRow.SCHEMA_NAME ?? tableRow.schemaName;
    const table = tableRow.TABLE_NAME ?? tableRow.tableName;
    const columns = await query(
      `SELECT COLUMN_NAME
         FROM SYS.TABLE_COLUMNS
        WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?`,
      [schema, table],
    );
    const available = new Set(
      columns.map((row) => row.COLUMN_NAME ?? row.columnName),
    );
    const selected = [
      "ASSESSMENT_ID",
      "SCORE_ID",
      "TRANSACTION_ID",
      "ALERT_ID",
    ].filter((column) => available.has(column));
    const rows = await query(
      `SELECT ${selected.map((column) => `"${column}"`).join(", ")}
         FROM "${schema}"."${table}"
        WHERE "TRANSACTION_ID" IN (${idPlaceholders})
        ORDER BY "TRANSACTION_ID"`,
      transactionIds,
    );
    if (rows.length > 0) {
      matches.push({
        schema,
        table,
        rows,
        purgeEligible: /ASSESSMENT|SCORE/.test(table),
      });
    }
  }

  if (matches.length === 0) {
    console.log(`No rows found for transaction IDs ${transactionIds.join(", ")}.`);
  }
  for (const match of matches) {
    console.log(
      `\n${match.schema}.${match.table} (${match.rows.length} row(s), ${
        match.purgeEligible ? "purge eligible" : "inspection only"
      })`,
    );
    console.table(match.rows);
  }

  if (!executePurge) {
    console.log("\nDry run only. Re-run with --execute to purge assessment/score rows.");
  } else {
    connection.setAutoCommit(false);
    try {
      let deleted = 0;
      for (const match of matches.filter((item) => item.purgeEligible)) {
        await query(
          `DELETE FROM "${match.schema}"."${match.table}"
            WHERE "TRANSACTION_ID" IN (${idPlaceholders})`,
          transactionIds,
        );
        deleted += match.rows.length;
      }
      connection.commit();
      console.log(`\nCommitted purge of ${deleted} assessment/score row(s).`);
    } catch (error) {
      connection.rollback();
      throw error;
    }
  }
} finally {
  await disconnect();
}
