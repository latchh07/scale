import hanaClient from "@sap/hana-client";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be configured for HANA-backed assessments`);
  }
  return value;
}

function schemaName() {
  const value = process.env.HANA_SCHEMA ?? "TEAM_12";
  if (!/^[A-Z0-9_]+$/i.test(value)) {
    throw new Error("HANA_SCHEMA may contain only letters, numbers, and underscores");
  }
  return value;
}

function asBoolean(value) {
  return value === true || value === 1 || String(value).toLowerCase() === "true";
}

function toDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Invalid HANA timestamp: ${value}`);
  }
  return date;
}

function median(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function sampleStandardDeviation(numbers, mean) {
  if (numbers.length <= 1) return Math.max(mean * 0.5, 1);
  const variance =
    numbers.reduce((total, value) => total + (value - mean) ** 2, 0) /
    (numbers.length - 1);
  return Math.max(Math.sqrt(variance), 1);
}

function query(connection, statement, parameters = []) {
  return new Promise((resolve, reject) => {
    connection.exec(statement, parameters, (error, rows) => {
      if (error) reject(error);
      else resolve(rows ?? []);
    });
  });
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
    connection.connect(options, (error) => {
      if (error) reject(error);
      else resolve(connection);
    });
  });
}

function disconnect(connection) {
  return new Promise((resolve) => {
    connection.disconnect(() => resolve());
  });
}

export function buildModelFeatures(transaction, history) {
  const currentTime = toDate(transaction.initiatedAt);
  const currentAmount = Number(transaction.amountUsd);
  const past = history
    .filter((item) => toDate(item.initiatedAt) < currentTime)
    .sort((left, right) => toDate(left.initiatedAt) - toDate(right.initiatedAt));
  const amounts = past.map((item) => Number(item.amountUsd));
  const priorMean = amounts.length
    ? amounts.reduce((total, value) => total + value, 0) / amounts.length
    : Math.max(currentAmount, 1);
  const priorStd = sampleStandardDeviation(amounts, priorMean);
  const oneHourAgo = currentTime.valueOf() - 60 * 60 * 1000;
  const oneDayAgo = currentTime.valueOf() - 24 * 60 * 60 * 1000;
  const recentHour = past.filter((item) => toDate(item.initiatedAt).valueOf() >= oneHourAgo);
  const recentDay = past.filter((item) => toDate(item.initiatedAt).valueOf() >= oneDayAgo);
  const lastTransaction = past.at(-1);
  const knownCounterparty = past.some(
    (item) => item.beneficiaryCompanyId === transaction.beneficiaryCompanyId,
  );
  const knownCountry = past.some(
    (item) => item.destinationCountryId === transaction.destinationCountryId,
  );
  const hour = currentTime.getUTCHours();

  return {
    transaction_id: transaction.transactionId,
    amount_ratio: currentAmount / Math.max(priorMean, 1),
    amount_zscore: Math.abs(currentAmount - priorMean) / priorStd,
    transaction_count_1h: recentHour.length,
    transaction_count_24h: recentDay.length,
    value_ratio_24h:
      (currentAmount + recentDay.reduce((total, item) => total + Number(item.amountUsd), 0)) /
      Math.max(priorMean, 1),
    hours_since_previous: lastTransaction
      ? Math.min(
          Math.max((currentTime - toDate(lastTransaction.initiatedAt)) / 3_600_000, 0),
          720,
        )
      : 720,
    is_new_counterparty: Number(!knownCounterparty),
    is_new_country: Number(!knownCountry),
    is_unusual_time: Number(hour < 6 || hour >= 22),
  };
}

function buildRuleInputs(transaction, history, owners, features) {
  const recentDay = history.filter(
    (item) =>
      toDate(item.initiatedAt).valueOf() >=
      toDate(transaction.initiatedAt).valueOf() - 24 * 60 * 60 * 1000,
  );
  const structuredAmounts = [...recentDay.map((item) => Number(item.amountUsd)), Number(transaction.amountUsd)]
    .filter((amount) => amount >= 8_000 && amount < 10_000);
  const expiry = transaction.kycExpiryDate ? toDate(transaction.kycExpiryDate) : null;
  const ownerPep = owners.some((owner) => asBoolean(owner.isPep));
  const ownerSanctions = owners.some((owner) => asBoolean(owner.sanctionsMatch));
  const destinationFatfStatus = transaction.destinationFatfStatus ?? "UNKNOWN";
  const highRiskDestination =
    transaction.destinationRiskTier === "HIGH" ||
    ["BLACK_LIST", "NON_COMPLIANT"].includes(destinationFatfStatus);

  return {
    sanctionsMatch: asBoolean(transaction.companySanctionsHit),
    beneficialOwnerSanctionsMatch: ownerSanctions,
    destinationCountrySanctioned: asBoolean(transaction.destinationSanctionsList),
    destinationFatfStatus,
    kycStatus: transaction.kycStatus,
    kycExpired: Boolean(expiry && expiry < toDate(transaction.initiatedAt)),
    pepExposure: asBoolean(transaction.companyPepAssociated) || ownerPep,
    highRiskIndustry:
      transaction.inherentRiskLevel === "HIGH" || transaction.amlSensitivity === "HIGH",
    adverseMedia: asBoolean(transaction.adverseMediaFlag),
    amountRatio: features.amount_ratio,
    valueRatio24h: features.value_ratio_24h,
    transactionCount1h: features.transaction_count_1h,
    transactionCount24h: features.transaction_count_24h,
    newCounterpartyLargeAmount:
      Boolean(features.is_new_counterparty) && features.amount_ratio >= 3,
    isUnusualTime: Boolean(features.is_unusual_time),
    newHighRiskCountry: Boolean(features.is_new_country) && highRiskDestination,
    highValueRoundAmount:
      Number(transaction.amountUsd) >= 10_000 &&
      Math.abs(Number(transaction.amountUsd) % 1_000) < 0.01,
    structuringIndicator:
      structuredAmounts.length >= 2 &&
      structuredAmounts.reduce((total, amount) => total + amount, 0) >= 10_000,
    rapidMovementIndicator: false,
  };
}

export async function loadTransactionContext(transactionId) {
  if (!transactionId) throw new Error("transactionId is required");
  const schema = schemaName();
  const connection = await connect();
  try {
    const [transactionRows] = await Promise.all([
      query(
        connection,
        `SELECT
          T."TRANSACTION_ID" AS "transactionId",
          T."ORIGINATOR_COMPANY_ID" AS "originatorCompanyId",
          T."BENEFICIARY_COMPANY_ID" AS "beneficiaryCompanyId",
          T."DESTINATION_COUNTRY_ID" AS "destinationCountryId",
          T."AMOUNT_USD" AS "amountUsd",
          T."INITIATED_AT" AS "initiatedAt",
          C."KYC_STATUS" AS "kycStatus",
          C."KYC_EXPIRY_DATE" AS "kycExpiryDate",
          C."PEP_ASSOCIATED" AS "companyPepAssociated",
          C."SANCTIONS_HIT" AS "companySanctionsHit",
          C."ADVERSE_MEDIA_FLAG" AS "adverseMediaFlag",
          I."INHERENT_RISK_LEVEL" AS "inherentRiskLevel",
          I."AML_SENSITIVITY" AS "amlSensitivity",
          D."FATF_STATUS" AS "destinationFatfStatus",
          D."SANCTIONS_LIST" AS "destinationSanctionsList",
          D."RISK_TIER" AS "destinationRiskTier"
        FROM "${schema}"."TRANSACTIONS" T
        JOIN "${schema}"."COMPANIES" C
          ON C."COMPANY_ID" = T."ORIGINATOR_COMPANY_ID"
        LEFT JOIN "${schema}"."INDUSTRIES" I
          ON I."INDUSTRY_ID" = C."INDUSTRY_ID"
        LEFT JOIN "${schema}"."COUNTRIES" D
          ON D."COUNTRY_ID" = T."DESTINATION_COUNTRY_ID"
        WHERE T."TRANSACTION_ID" = ?`,
        [transactionId],
      ),
    ]);
    const transaction = transactionRows[0];
    if (!transaction) {
      const error = new Error(`Transaction ${transactionId} was not found`);
      error.code = "TRANSACTION_NOT_FOUND";
      throw error;
    }

    const [history, owners] = await Promise.all([
      query(
        connection,
        `SELECT
          "BENEFICIARY_COMPANY_ID" AS "beneficiaryCompanyId",
          "DESTINATION_COUNTRY_ID" AS "destinationCountryId",
          "AMOUNT_USD" AS "amountUsd",
          "INITIATED_AT" AS "initiatedAt"
        FROM "${schema}"."TRANSACTIONS"
        WHERE "ORIGINATOR_COMPANY_ID" = ?
          AND "INITIATED_AT" < ?
        ORDER BY "INITIATED_AT" ASC, "TRANSACTION_ID" ASC`,
        [transaction.originatorCompanyId, transaction.initiatedAt],
      ),
      query(
        connection,
        `SELECT
          "IS_PEP" AS "isPep",
          "SANCTIONS_MATCH" AS "sanctionsMatch"
        FROM "${schema}"."COMPANY_BENEFICIAL_OWNERS"
        WHERE "COMPANY_ID" = ?`,
        [transaction.originatorCompanyId],
      ),
    ]);
    const modelFeatures = buildModelFeatures(transaction, history);
    return {
      transaction,
      historyCount: history.length,
      modelFeatures,
      ruleInputs: buildRuleInputs(transaction, history, owners, modelFeatures),
    };
  } finally {
    await disconnect(connection);
  }
}
