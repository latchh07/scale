/**
 * Demo fixtures for the Meridian workbench.
 *
 * Every object below is the *exact* shape returned by Chengxi's
 * POST /api/risk-assessments/from-transaction (backend/src/server.js), so the
 * UI renders identically whether it is reading demo data or live HANA data.
 *
 * All scores were computed by hand against backend/config/risk-policy.json
 * v2.1.0 (80% rules / 20% anomaly, sanctions hard overrides, exclusive groups),
 * so the demo numbers are arithmetically honest rather than invented.
 *
 * The one addition is the optional `transaction` block. The live backend does
 * not return it yet — see README "Suggested backend addition". The UI degrades
 * gracefully when it is absent.
 */

const daysAgo = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
};

const now = new Date().toISOString();

export const MOCK_ASSESSMENTS = [
  {
    alertId: "ALT-4471",
    transactionId: "88214007",
    assessment: {
      overallScore: 100,
      riskLevel: "CRITICAL",
      recommendedAction: "HOLD_AND_ESCALATE",
      hardOverride: true,
    },
    scoreBreakdown: {
      ruleScore: 100,
      anomalyScore: 97,
      ruleWeight: 0.8,
      anomalyWeight: 0.2,
      anomalyAvailable: true,
    },
    rulesTriggered: [
      { ruleId: "EXTREME_AMOUNT_DEVIATION", description: "Amount is at least ten times the customer's prior norm", points: 30 },
      { ruleId: "STRUCTURING_PATTERN", description: "Multiple near-threshold transactions collectively exceed the threshold", points: 25 },
      { ruleId: "PEP_EXPOSURE", description: "Company or beneficial owner has PEP exposure", points: 20 },
      { ruleId: "FATF_GREY_LIST", description: "Destination is on the FATF grey list", points: 15 },
      { ruleId: "ADVERSE_MEDIA", description: "Adverse-media flag is present", points: 10 },
      { ruleId: "HIGH_VALUE_ROUND_AMOUNT", description: "High-value transaction uses a round amount", points: 10 },
      { ruleId: "HIGH_RISK_INDUSTRY", description: "Industry has high inherent risk or AML sensitivity", points: 5 },
    ],
    hardOverrides: [
      { ruleId: "ENTITY_SANCTIONS_MATCH", description: "Confirmed sanctions match for a transaction party", minimumScore: 100 },
    ],
    modelSignals: {
      modelVersion: "v3-chronological",
      anomalyFlag: true,
      anomalyBand: "HIGH",
      topDeviations: [
        "Unusual amount compared with the customer's normal amount (18.40)",
        "Unusual daily transferred value compared with normal (22.10)",
        "New counterparty",
      ],
    },
    policyVersion: "2.1.0",
    generatedAt: now,
    featureSnapshot: {
      transaction_id: "88214007",
      amount_ratio: 18.4,
      amount_zscore: 9.62,
      transaction_count_1h: 4,
      transaction_count_24h: 11,
      value_ratio_24h: 22.1,
      hours_since_previous: 0.42,
      is_new_counterparty: 1,
      is_new_country: 1,
      is_unusual_time: 1,
    },
    historyTransactionCount: 214,
    transaction: {
      amountUsd: 4200000,
      currency: "USD",
      originatorName: "Meridian Freight Holdings",
      originatorCountry: "Singapore",
      destinationCountry: "Nicosia (CY)",
      productType: "Trade finance",
      initiatedAt: daysAgo(19),
    },
  },
  {
    alertId: "ALT-4419",
    transactionId: "88213660",
    assessment: {
      overallScore: 76,
      riskLevel: "HIGH",
      recommendedAction: "PRIORITY_REVIEW",
      hardOverride: false,
    },
    scoreBreakdown: {
      ruleScore: 75,
      anomalyScore: 82,
      ruleWeight: 0.8,
      anomalyWeight: 0.2,
      anomalyAvailable: true,
    },
    rulesTriggered: [
      { ruleId: "HIGH_AMOUNT_DEVIATION", description: "Amount is at least five times the customer's prior norm", points: 20 },
      { ruleId: "PEP_EXPOSURE", description: "Company or beneficial owner has PEP exposure", points: 20 },
      { ruleId: "FATF_GREY_LIST", description: "Destination is on the FATF grey list", points: 15 },
      { ruleId: "ADVERSE_MEDIA", description: "Adverse-media flag is present", points: 10 },
      { ruleId: "NEW_COUNTERPARTY_LARGE_PAYMENT", description: "First payment to this counterparty is at least three times the customer's prior norm", points: 10 },
    ],
    hardOverrides: [],
    modelSignals: {
      modelVersion: "v3-chronological",
      anomalyFlag: false,
      anomalyBand: "MEDIUM",
      topDeviations: [
        "Unusual amount compared with the customer's normal amount (6.20)",
        "Unusual transaction frequency in the last 24 hours (9.00)",
        "New counterparty",
      ],
    },
    policyVersion: "2.1.0",
    generatedAt: now,
    featureSnapshot: {
      transaction_id: "88213660",
      amount_ratio: 6.2,
      amount_zscore: 4.11,
      transaction_count_1h: 1,
      transaction_count_24h: 9,
      value_ratio_24h: 8.4,
      hours_since_previous: 2.7,
      is_new_counterparty: 1,
      is_new_country: 0,
      is_unusual_time: 0,
    },
    historyTransactionCount: 96,
    transaction: {
      amountUsd: 1840000,
      currency: "USD",
      originatorName: "Kirana Capital Partners",
      originatorCountry: "New York",
      destinationCountry: "Jakarta",
      productType: "Wire transfer",
      initiatedAt: daysAgo(11),
    },
  },
  {
    alertId: "ALT-4382",
    transactionId: "88211902",
    assessment: {
      overallScore: 66,
      riskLevel: "HIGH",
      recommendedAction: "PRIORITY_REVIEW",
      hardOverride: false,
    },
    scoreBreakdown: {
      ruleScore: 65,
      anomalyScore: 71,
      ruleWeight: 0.8,
      anomalyWeight: 0.2,
      anomalyAvailable: true,
    },
    rulesTriggered: [
      { ruleId: "STRUCTURING_PATTERN", description: "Multiple near-threshold transactions collectively exceed the threshold", points: 25 },
      { ruleId: "KYC_EXPIRED_AT_TRANSACTION_TIME", description: "KYC was expired when the transaction was initiated", points: 15 },
      { ruleId: "ADVERSE_MEDIA", description: "Adverse-media flag is present", points: 10 },
      { ruleId: "ELEVATED_AMOUNT_DEVIATION", description: "Amount is at least three times the customer's prior norm", points: 10 },
      { ruleId: "HIGH_RISK_INDUSTRY", description: "Industry has high inherent risk or AML sensitivity", points: 5 },
    ],
    hardOverrides: [],
    modelSignals: {
      modelVersion: "v3-chronological",
      anomalyFlag: false,
      anomalyBand: "MEDIUM",
      topDeviations: [
        "Unusual transaction frequency in the last 24 hours (14.00)",
        "Unusual time since the previous transaction (0.18)",
        "Unusual transaction time",
      ],
    },
    policyVersion: "2.1.0",
    generatedAt: now,
    featureSnapshot: {
      transaction_id: "88211902",
      amount_ratio: 3.4,
      amount_zscore: 2.85,
      transaction_count_1h: 6,
      transaction_count_24h: 14,
      value_ratio_24h: 5.9,
      hours_since_previous: 0.18,
      is_new_counterparty: 0,
      is_new_country: 0,
      is_unusual_time: 1,
    },
    historyTransactionCount: 341,
    transaction: {
      amountUsd: 995000,
      currency: "EUR",
      originatorName: "Hanseatic Metals GmbH",
      originatorCountry: "Frankfurt",
      destinationCountry: "Seoul",
      productType: "Correspondent",
      initiatedAt: daysAgo(14),
    },
  },
  {
    alertId: "ALT-4407",
    transactionId: "88212118",
    assessment: {
      overallScore: 44,
      riskLevel: "MEDIUM",
      recommendedAction: "STANDARD_REVIEW",
      hardOverride: false,
    },
    scoreBreakdown: {
      ruleScore: 40,
      anomalyScore: 58,
      ruleWeight: 0.8,
      anomalyWeight: 0.2,
      anomalyAvailable: true,
    },
    rulesTriggered: [
      { ruleId: "STRUCTURING_PATTERN", description: "Multiple near-threshold transactions collectively exceed the threshold", points: 25 },
      { ruleId: "HIGH_VALUE_ROUND_AMOUNT", description: "High-value transaction uses a round amount", points: 10 },
      { ruleId: "UNUSUAL_TIME", description: "Transaction occurred outside 06:00-22:00", points: 5 },
    ],
    hardOverrides: [],
    modelSignals: {
      modelVersion: "v3-chronological",
      anomalyFlag: false,
      anomalyBand: "LOW",
      topDeviations: [
        "Unusual transaction frequency in the last 24 hours (8.00)",
        "Unusual transaction time",
      ],
    },
    policyVersion: "2.1.0",
    generatedAt: now,
    featureSnapshot: {
      transaction_id: "88212118",
      amount_ratio: 1.9,
      amount_zscore: 1.42,
      transaction_count_1h: 2,
      transaction_count_24h: 8,
      value_ratio_24h: 3.1,
      hours_since_previous: 1.9,
      is_new_counterparty: 0,
      is_new_country: 0,
      is_unusual_time: 1,
    },
    historyTransactionCount: 178,
    transaction: {
      amountUsd: 780000,
      currency: "GBP",
      originatorName: "Thames Bridge Advisory",
      originatorCountry: "London",
      destinationCountry: "Amsterdam",
      productType: "Wire transfer",
      initiatedAt: daysAgo(6),
    },
  },
  {
    // Demonstrates the MODEL_UNAVAILABLE fallback path: rules carry 100% of the
    // score when SAP AI Core cannot be reached.
    alertId: "ALT-4356",
    transactionId: "88209774",
    assessment: {
      overallScore: 40,
      riskLevel: "MEDIUM",
      recommendedAction: "STANDARD_REVIEW",
      hardOverride: false,
    },
    scoreBreakdown: {
      ruleScore: 40,
      anomalyScore: null,
      ruleWeight: 1,
      anomalyWeight: 0,
      anomalyAvailable: false,
    },
    rulesTriggered: [
      { ruleId: "FATF_GREY_LIST", description: "Destination is on the FATF grey list", points: 15 },
      { ruleId: "NEW_HIGH_RISK_COUNTRY", description: "First payment to a high-risk destination country", points: 15 },
      { ruleId: "ELEVATED_AMOUNT_DEVIATION", description: "Amount is at least three times the customer's prior norm", points: 10 },
    ],
    hardOverrides: [],
    modelSignals: {
      modelVersion: null,
      anomalyFlag: null,
      anomalyBand: null,
      topDeviations: [],
      status: "MODEL_UNAVAILABLE",
    },
    policyVersion: "2.1.0",
    generatedAt: now,
    featureSnapshot: {
      transaction_id: "88209774",
      amount_ratio: 3.1,
      amount_zscore: 2.04,
      transaction_count_1h: 0,
      transaction_count_24h: 3,
      value_ratio_24h: 4.2,
      hours_since_previous: 26.5,
      is_new_counterparty: 1,
      is_new_country: 1,
      is_unusual_time: 0,
    },
    historyTransactionCount: 62,
    transaction: {
      amountUsd: 275000,
      currency: "USD",
      originatorName: "Northline Logistics",
      originatorCountry: "Toronto",
      destinationCountry: "Ho Chi Minh City",
      productType: "Wire transfer",
      initiatedAt: daysAgo(9),
    },
  },
  {
    alertId: "ALT-4290",
    transactionId: "88205331",
    assessment: {
      overallScore: 12,
      riskLevel: "LOW",
      recommendedAction: "MONITOR",
      hardOverride: false,
    },
    scoreBreakdown: {
      ruleScore: 10,
      anomalyScore: 22,
      ruleWeight: 0.8,
      anomalyWeight: 0.2,
      anomalyAvailable: true,
    },
    rulesTriggered: [
      { ruleId: "UNUSUAL_TIME", description: "Transaction occurred outside 06:00-22:00", points: 5 },
      { ruleId: "HIGH_RISK_INDUSTRY", description: "Industry has high inherent risk or AML sensitivity", points: 5 },
    ],
    hardOverrides: [],
    modelSignals: {
      modelVersion: "v3-chronological",
      anomalyFlag: false,
      anomalyBand: "LOW",
      topDeviations: ["No major individual feature deviation identified"],
    },
    policyVersion: "2.1.0",
    generatedAt: now,
    featureSnapshot: {
      transaction_id: "88205331",
      amount_ratio: 1.1,
      amount_zscore: 0.34,
      transaction_count_1h: 0,
      transaction_count_24h: 2,
      value_ratio_24h: 1.4,
      hours_since_previous: 19.2,
      is_new_counterparty: 0,
      is_new_country: 0,
      is_unusual_time: 1,
    },
    historyTransactionCount: 508,
    transaction: {
      amountUsd: 96000,
      currency: "EUR",
      originatorName: "Willow & Vale Ltd",
      originatorCountry: "Amsterdam",
      destinationCountry: "London",
      productType: "Wire transfer",
      initiatedAt: daysAgo(3),
    },
  },
];

export const MOCK_HEALTH = {
  status: "demo",
  policyVersion: "2.1.0",
  anomalyServiceConfigured: false,
};
