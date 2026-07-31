import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

import hana from "@sap/hana-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", "..", "team_12.env") });

const executePurge = process.argv.includes("--execute");
const threshold = 900000;
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
  const placeholders = schemas.map(() => "?").join(", ");
  const tables = await query(
    `SELECT C.SCHEMA_NAME, C.TABLE_NAME
       FROM SYS.TABLE_COLUMNS C
       JOIN SYS.TABLES T
         ON T.SCHEMA_NAME = C.SCHEMA_NAME
        AND T.TABLE_NAME = C.TABLE_NAME
      WHERE C.COLUMN_NAME = ?
        AND C.SCHEMA_NAME IN (${placeholders})
      ORDER BY C.SCHEMA_NAME, C.TABLE_NAME`,
    ["TRANSACTION_ID", ...schemas],
  );

  const matches = [];
  for (const row of tables) {
    const schema = row.SCHEMA_NAME ?? row.schemaName;
    const table = row.TABLE_NAME ?? row.tableName;
    const counts = await query(
      `SELECT COUNT(*) AS "matchCount",
              SUM(CASE WHEN "TRANSACTION_ID" = ? THEN 1 ELSE 0 END) AS "specificCount",
              MIN("TRANSACTION_ID") AS "minId",
              MAX("TRANSACTION_ID") AS "maxId"
         FROM "${schema}"."${table}"
        WHERE "TRANSACTION_ID" >= ?`,
      [999123, threshold],
    );
    const result = counts[0] ?? {};
    matches.push({
      schema,
      table,
      matchCount: Number(result.matchCount ?? result.MATCHCOUNT ?? 0),
      specificCount: Number(result.specificCount ?? result.SPECIFICCOUNT ?? 0),
      minId: result.minId ?? result.MINID ?? null,
      maxId: result.maxId ?? result.MAXID ?? null,
    });
  }

  console.table(matches);
  if (!executePurge) {
    console.log("Dry run only. Re-run with --execute to delete the matching rows.");
  } else {
    connection.setAutoCommit(false);
    try {
      for (const match of matches.filter((item) => item.matchCount > 0)) {
        await query(
          `DELETE FROM "${match.schema}"."${match.table}" WHERE "TRANSACTION_ID" >= ?`,
          [threshold],
        );
      }
      connection.commit();
      console.log(`Committed purge of ${matches.reduce((sum, item) => sum + item.matchCount, 0)} rows.`);
    } catch (error) {
      connection.rollback();
      throw error;
    }
  }
} finally {
  await disconnect();
}
