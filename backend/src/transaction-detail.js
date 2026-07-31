/**
 * Descriptive detail for a transaction: amount, currency, counterparty name,
 * corridor and product type.
 *
 * Kept separate from hana-context.js on purpose. That file feeds the scoring
 * path and must not be destabilised; this is presentation detail only, and a
 * failure here returns null rather than affecting an assessment.
 *
 * Column names are discovered from SYS.TABLE_COLUMNS rather than assumed, so
 * the lookup adapts to whatever TEAM_12 actually calls things (COMPANY_NAME vs
 * LEGAL_NAME, COUNTRY_ID vs HQ_COUNTRY_ID, and so on).
 */

import hanaClient from "@sap/hana-client";

const SAFE_IDENTIFIER = /^[A-Z0-9_]+$/i;

const CANDIDATES = {
  companyName: ["LEGAL_NAME", "COMPANY_NAME", "TRADING_NAME", "REGISTERED_NAME", "NAME"],
  // The payment's own origin, not where the originator happens to be registered.
  // TEAM_12.TRANSACTIONS carries ORIGINATING_COUNTRY_ID; using the company's
  // headquarters instead produced misleading corridors.
  originCountry: ["ORIGINATING_COUNTRY_ID", "ORIGIN_COUNTRY_ID", "SOURCE_COUNTRY_ID"],
  destinationCountry: ["DESTINATION_COUNTRY_ID", "BENEFICIARY_COUNTRY_ID"],
  // Fallback only, when the transaction carries no origin of its own.
  companyCountry: [
    "HEADQUARTERS_COUNTRY_ID",
    "COUNTRY_ID",
    "HQ_COUNTRY_ID",
    "DOMICILE_COUNTRY_ID",
    "INCORPORATION_COUNTRY_ID",
  ],
  countryName: ["COUNTRY_NAME", "NAME"],
  productType: ["TRANSACTION_TYPE", "PRODUCT_TYPE", "PAYMENT_TYPE", "CHANNEL", "TYPE"],
  currency: ["CURRENCY_ORIGINAL", "CURRENCY", "CURRENCY_CODE"],
  beneficiaryName: ["BENEFICIARY_NAME"],
  crossBorder: ["IS_CROSS_BORDER"],
};

function schemaName() {
  const value = process.env.HANA_SCHEMA ?? "TEAM_12";
  if (!SAFE_IDENTIFIER.test(value)) throw new Error("HANA_SCHEMA is not a valid identifier");
  return value;
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

/** Resolved once per process — the schema does not change under us. */
let layoutPromise = null;

async function resolveLayout(connection, schema) {
  const rows = await query(
    connection,
    `SELECT TABLE_NAME AS "table", COLUMN_NAME AS "column"
     FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ?`,
    [schema.toUpperCase()],
  );

  const byTable = new Map();
  for (const row of rows) {
    const table = row.table ?? row.TABLE_NAME;
    const column = row.column ?? row.COLUMN_NAME;
    if (!byTable.has(table)) byTable.set(table, new Set());
    byTable.get(table).add(column);
  }

  const pick = (table, key) => {
    const columns = byTable.get(table);
    const found = CANDIDATES[key].find((c) => columns?.has(c));
    return found && SAFE_IDENTIFIER.test(found) ? found : null;
  };

  return {
    companyName: pick("COMPANIES", "companyName"),
    companyCountry: pick("COMPANIES", "companyCountry"),
    originCountry: pick("TRANSACTIONS", "originCountry"),
    destinationCountry: pick("TRANSACTIONS", "destinationCountry"),
    countryName: pick("COUNTRIES", "countryName"),
    productType: pick("TRANSACTIONS", "productType"),
    currency: pick("TRANSACTIONS", "currency"),
    beneficiaryName: pick("TRANSACTIONS", "beneficiaryName"),
    crossBorder: pick("TRANSACTIONS", "crossBorder"),
  };
}

function buildSql(schema, layout) {
  // Prefer the transaction's own origin; fall back to the originator company's
  // registered country only if the table does not carry one.
  const originExpr = layout.originCountry
    ? `T."${layout.originCountry}"`
    : layout.companyCountry
      ? `C."${layout.companyCountry}"`
      : null;
  const destExpr = layout.destinationCountry ? `T."${layout.destinationCountry}"` : null;

  const select = [
    `T."AMOUNT_USD" AS "amountUsd"`,
    `T."INITIATED_AT" AS "initiatedAt"`,
    `T."ORIGINATOR_COMPANY_ID" AS "originatorCompanyId"`,
  ];
  if (destExpr) select.push(`${destExpr} AS "destinationCountryId"`);
  if (layout.currency) select.push(`T."${layout.currency}" AS "currency"`);
  if (layout.productType) select.push(`T."${layout.productType}" AS "productType"`);
  if (layout.beneficiaryName) select.push(`T."${layout.beneficiaryName}" AS "beneficiaryName"`);
  if (layout.crossBorder) select.push(`T."${layout.crossBorder}" AS "crossBorder"`);
  if (layout.companyName) select.push(`C."${layout.companyName}" AS "originatorName"`);
  if (layout.countryName) {
    if (destExpr) select.push(`DC."${layout.countryName}" AS "destinationCountry"`);
    if (originExpr) select.push(`OC."${layout.countryName}" AS "originatorCountry"`);
  }

  const joins = [`LEFT JOIN "${schema}"."COMPANIES" C ON C."COMPANY_ID" = T."ORIGINATOR_COMPANY_ID"`];
  if (layout.countryName && destExpr) {
    joins.push(`LEFT JOIN "${schema}"."COUNTRIES" DC ON DC."COUNTRY_ID" = ${destExpr}`);
  }
  if (layout.countryName && originExpr) {
    joins.push(`LEFT JOIN "${schema}"."COUNTRIES" OC ON OC."COUNTRY_ID" = ${originExpr}`);
  }

  return `SELECT ${select.join(", ")}
          FROM "${schema}"."TRANSACTIONS" T
          ${joins.join("\n          ")}
          WHERE T."TRANSACTION_ID" = ?`;
}

/**
 * Returns the descriptive block for a transaction, or null if it cannot be
 * built. Never throws — presentation detail must not break an assessment.
 */
export async function loadTransactionDetail(transactionId) {
  if (!transactionId) return null;
  let connection;
  try {
    const schema = schemaName();
    connection = await connect();

    if (!layoutPromise) layoutPromise = resolveLayout(connection, schema);
    const layout = await layoutPromise;

    const [row] = await query(connection, buildSql(schema, layout), [transactionId]);
    if (!row) return null;

    const crossBorder =
      row.crossBorder == null
        ? null
        : ["true", "1", "y", "yes"].includes(String(row.crossBorder).toLowerCase());

    return {
      amountUsd: row.amountUsd == null ? null : Number(row.amountUsd),
      currency: row.currency ?? "USD",
      originatorName: row.originatorName ?? row.originatorCompanyId ?? null,
      beneficiaryName: row.beneficiaryName ?? null,
      originatorCountry: row.originatorCountry ?? null,
      destinationCountry: row.destinationCountry ?? row.destinationCountryId ?? null,
      productType: row.productType ?? null,
      crossBorder,
      initiatedAt: row.initiatedAt ?? null,
    };
  } catch (error) {
    console.error("Transaction detail unavailable:", error.message);
    layoutPromise = null; // re-resolve next time in case the failure was transient
    return null;
  } finally {
    if (connection) connection.disconnect(() => {});
  }
}
