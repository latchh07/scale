import crypto from "node:crypto";

import hanaClient from "@sap/hana-client";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured for assessment persistence`);
  return value;
}

function identifier(value, name) {
  if (!/^[A-Z0-9_]+$/i.test(value)) {
    throw new Error(`${name} may contain only letters, numbers, and underscores`);
  }
  return value;
}

function sourceSchema() {
  return identifier(process.env.HANA_SCHEMA ?? "TEAM_12", "HANA_SCHEMA");
}

function writeSchema() {
  return identifier(
    process.env.HANA_WRITE_SCHEMA ?? process.env.HANA_USER ?? "TEAM_12_USER",
    "HANA_WRITE_SCHEMA",
  );
}

function connect() {
  const connection = hanaClient.createConnection();
  const options = {
    host: requiredEnvironment("HANA_HOST"),
    port: Number(requiredEnvironment("HANA_PORT")),
    uid: requiredEnvironment("HANA_USER"),
    pwd: requiredEnvironment("HANA_PASSWORD"),
    encrypt: true,
    sslValidateCertificate: process.env.HANA_SSL_VALIDATE_CERTIFICATE === "true",
  };
  return new Promise((resolve, reject) => {
    connection.connect(options, (error) => (error ? reject(error) : resolve(connection)));
  });
}

function execute(connection, statement, parameters = []) {
  return new Promise((resolve, reject) => {
    connection.exec(statement, parameters, (error, rows) => (error ? reject(error) : resolve(rows ?? [])));
  });
}

function disconnect(connection) {
  return new Promise((resolve) => connection.disconnect(() => resolve()));
}

export async function ensureAssessmentStore() {
  const schema = writeSchema();
  const connection = await connect();
  try {
    const existing = await execute(
      connection,
      "SELECT COUNT(*) AS \"count\" FROM SYS.TABLES WHERE SCHEMA_NAME = ? AND TABLE_NAME = 'RISK_ASSESSMENTS'",
      [schema.toUpperCase()],
    );
    if (Number(existing[0]?.count ?? existing[0]?.COUNT ?? 0) > 0) {
      const columns = await execute(
        connection,
        "SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = 'RISK_ASSESSMENTS'",
        [schema.toUpperCase()],
      );
      const names = new Set(columns.map((row) => row.columnName ?? row.COLUMN_NAME));
      if (names.has("CASE_ID") && !names.has("SOURCE_CASE_ID")) {
        await execute(
          connection,
          `RENAME COLUMN "${schema}"."RISK_ASSESSMENTS"."CASE_ID" TO "SOURCE_CASE_ID"`,
        );
        names.delete("CASE_ID");
        names.add("SOURCE_CASE_ID");
      }
      if (!names.has("CASE_ID")) {
        await execute(
          connection,
          `ALTER TABLE "${schema}"."RISK_ASSESSMENTS" ADD (
            "CASE_ID" BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1)
          )`,
        );
      }
      return false;
    }

    await execute(
      connection,
      `CREATE COLUMN TABLE "${schema}"."RISK_ASSESSMENTS" (
        "ASSESSMENT_ID" NVARCHAR(64) NOT NULL,
        "TRANSACTION_ID" NVARCHAR(100) NOT NULL,
        "ALERT_ID" NVARCHAR(100),
        "SOURCE_CASE_ID" NVARCHAR(100),
        "CASE_ID" BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1),
        "OVERALL_SCORE" INTEGER NOT NULL,
        "RISK_LEVEL" NVARCHAR(20) NOT NULL,
        "RECOMMENDED_ACTION" NVARCHAR(50) NOT NULL,
        "RULE_SCORE" INTEGER NOT NULL,
        "ANOMALY_SCORE" INTEGER,
        "RULES_TRIGGERED_JSON" NCLOB,
        "MODEL_SIGNALS_JSON" NCLOB,
        "FEATURE_SNAPSHOT_JSON" NCLOB,
        "ASSESSMENT_JSON" NCLOB NOT NULL,
        "POLICY_VERSION" NVARCHAR(30) NOT NULL,
        "REVIEW_STATUS" NVARCHAR(30) NOT NULL DEFAULT 'PENDING',
        "GENERATED_AT" TIMESTAMP NOT NULL,
        "CREATED_AT" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("ASSESSMENT_ID")
      )`,
    );
    await execute(
      connection,
      `CREATE INDEX "RISK_ASSESSMENTS_QUEUE_IDX"
       ON "${schema}"."RISK_ASSESSMENTS" ("RISK_LEVEL", "OVERALL_SCORE", "GENERATED_AT")`,
    );
    return true;
  } finally {
    await disconnect(connection);
  }
}

export async function persistAssessment({ assessment, featureSnapshot = null, sourceCaseId = null }) {
  const schema = writeSchema();
  const assessmentId = crypto.randomUUID();
  const connection = await connect();
  try {
    await execute(
      connection,
      `INSERT INTO "${schema}"."RISK_ASSESSMENTS" (
        "ASSESSMENT_ID", "TRANSACTION_ID", "ALERT_ID", "SOURCE_CASE_ID",
        "OVERALL_SCORE", "RISK_LEVEL", "RECOMMENDED_ACTION", "RULE_SCORE", "ANOMALY_SCORE",
        "RULES_TRIGGERED_JSON", "MODEL_SIGNALS_JSON", "FEATURE_SNAPSHOT_JSON", "ASSESSMENT_JSON",
        "POLICY_VERSION", "GENERATED_AT"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        assessmentId,
        String(assessment.transactionId),
        assessment.alertId == null ? null : String(assessment.alertId),
        sourceCaseId == null ? null : String(sourceCaseId),
        Number(assessment.assessment.overallScore),
        assessment.assessment.riskLevel,
        assessment.assessment.recommendedAction,
        Number(assessment.scoreBreakdown.ruleScore),
        assessment.scoreBreakdown.anomalyScore == null
          ? null
          : Number(assessment.scoreBreakdown.anomalyScore),
        JSON.stringify(assessment.rulesTriggered ?? []),
        JSON.stringify(assessment.modelSignals ?? {}),
        featureSnapshot == null ? null : JSON.stringify(featureSnapshot),
        JSON.stringify(assessment),
        assessment.policyVersion,
        new Date(assessment.generatedAt),
      ],
    );
    const saved = await execute(
      connection,
      `SELECT "CASE_ID" AS "caseId" FROM "${schema}"."RISK_ASSESSMENTS" WHERE "ASSESSMENT_ID" = ?`,
      [assessmentId],
    );
    return { assessmentId, caseId: Number(saved[0]?.caseId ?? saved[0]?.CASEID) };
  } finally {
    await disconnect(connection);
  }
}

export async function listAssessmentSummaries(limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const schema = writeSchema();
  const connection = await connect();
  try {
    return await execute(
      connection,
      `SELECT TOP ${safeLimit}
        "ASSESSMENT_ID" AS "assessmentId",
        "TRANSACTION_ID" AS "transactionId",
        "ALERT_ID" AS "alertId",
        "CASE_ID" AS "caseId",
        "SOURCE_CASE_ID" AS "sourceCaseId",
        "OVERALL_SCORE" AS "overallScore",
        "RISK_LEVEL" AS "riskLevel",
        "RECOMMENDED_ACTION" AS "recommendedAction",
        "REVIEW_STATUS" AS "reviewStatus",
        "GENERATED_AT" AS "generatedAt"
       FROM "${schema}"."RISK_ASSESSMENTS"
       ORDER BY "OVERALL_SCORE" DESC, "GENERATED_AT" DESC`,
    );
  } finally {
    await disconnect(connection);
  }
}

export async function loadAssessment(assessmentId) {
  const schema = writeSchema();
  const connection = await connect();
  try {
    const rows = await execute(
      connection,
      `SELECT "ASSESSMENT_JSON" AS "assessmentJson", "CASE_ID" AS "caseId", "SOURCE_CASE_ID" AS "sourceCaseId", "REVIEW_STATUS" AS "reviewStatus"
       FROM "${schema}"."RISK_ASSESSMENTS"
       WHERE "ASSESSMENT_ID" = ?`,
      [assessmentId],
    );
    if (!rows[0]) return null;
    const raw = rows[0].assessmentJson ?? rows[0].ASSESSMENTJSON;
    const assessment = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      ...assessment,
      assessmentId,
      caseId: rows[0].caseId ?? rows[0].CASEID ?? null,
      sourceCaseId: rows[0].sourceCaseId ?? rows[0].SOURCECASEID ?? null,
      reviewStatus: rows[0].reviewStatus ?? rows[0].REVIEWSTATUS ?? null,
      persistence: "SAVED",
    };
  } finally {
    await disconnect(connection);
  }
}

export function assessmentStoreConfiguration() {
  return {
    sourceSchema: sourceSchema(),
    writeSchema: writeSchema(),
  };
}
