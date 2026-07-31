/**
 * Simulate new transactions arriving at the Financial Crime Operations desk.
 *
 * Each simulated transaction is built as a coherent pair of
 *   - `ruleInputs`     : the compliance facts the deterministic engine scores
 *   - `modelFeatures`  : the nine behavioural features the anomaly model reads
 * so the rule ledger and the feature snapshot in the UI always agree.
 *
 * It POSTs to /api/risk-assessments, which means the score is produced by the
 * real policy engine and the record is persisted through assessment-store.js —
 * exactly like a live alert. Nothing is faked downstream of the request body.
 *
 * TEAM_12 is read-only for our user, so this deliberately does NOT insert into
 * TEAM_12.TRANSACTIONS. It injects at the API boundary instead.
 *
 * Usage
 *   npm run simulate                          one random transaction
 *   npm run simulate -- sanctions             force a Critical hard override
 *   npm run simulate -- --count 8             a burst of eight
 *   npm run simulate -- --watch --interval 5000   continuous feed until Ctrl-C
 *   npm run simulate -- --live-model          let the backend call SAP AI Core
 *
 * Scenarios
 *   sanctions    Critical. Sanctions hard override, score floored at 100.
 *   structuring  Watch/High. Near-threshold cluster crossing the threshold.
 *   pep          High. PEP exposure plus adverse media on a large payment.
 *   velocity     High. Amount and frequency spike — anomaly-model driven.
 *   clean        Low. Ordinary payment, nothing material triggered.
 *   model-down   Watch. Exercises the MODEL_UNAVAILABLE fallback (rules at 100%).
 *   random       Weighted mix, realistic skew toward Low/Watch. (default)
 */

const API_BASE_URL = (process.env.RISK_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

/* ---------------------------------------------------------------- args --- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SCENARIOS = ["sanctions", "structuring", "pep", "velocity", "clean", "model-down", "random"];
const requested = argv.find((a) => !a.startsWith("--") && SCENARIOS.includes(a)) ?? "random";
const unknown = argv.find((a) => !a.startsWith("--") && !SCENARIOS.includes(a) && !argv[argv.indexOf(a) - 1]?.startsWith("--"));

if (unknown) {
  console.error(`Unknown scenario "${unknown}". Choose one of: ${SCENARIOS.join(", ")}`);
  process.exit(1);
}

const options = {
  scenario: requested,
  count: Number(value("count", 1)),
  interval: Number(value("interval", 3000)),
  watch: flag("watch"),
  liveModel: flag("live-model"),
  quiet: flag("quiet") || flag("watch"),
  modelVersion: value("model-version", "sim-v1"),
};

/* ------------------------------------------------------------- fixtures --- */

const COMPANIES = [
  { name: "Meridian Freight Holdings", country: "Singapore", industryRisk: true },
  { name: "Kirana Capital Partners", country: "New York", industryRisk: false },
  { name: "Hanseatic Metals GmbH", country: "Frankfurt", industryRisk: true },
  { name: "Thames Bridge Advisory", country: "London", industryRisk: false },
  { name: "Northline Logistics", country: "Toronto", industryRisk: false },
  { name: "Willow & Vale Ltd", country: "Amsterdam", industryRisk: false },
  { name: "Coastal Bunkering SA", country: "Singapore", industryRisk: true },
  { name: "Pearl River Trading Co", country: "Seoul", industryRisk: false },
  { name: "Rhine Valley Chemicals", country: "Frankfurt", industryRisk: true },
  { name: "Anchor Point Securities", country: "London", industryRisk: false },
];

const DESTINATIONS = [
  { name: "Amsterdam", fatf: "COMPLIANT", highRisk: false, sanctioned: false },
  { name: "London", fatf: "COMPLIANT", highRisk: false, sanctioned: false },
  { name: "Seoul", fatf: "COMPLIANT", highRisk: false, sanctioned: false },
  { name: "Toronto", fatf: "COMPLIANT", highRisk: false, sanctioned: false },
  { name: "Jakarta", fatf: "GREY_LIST", highRisk: true, sanctioned: false },
  { name: "Ho Chi Minh City", fatf: "GREY_LIST", highRisk: true, sanctioned: false },
  { name: "Nicosia (CY)", fatf: "GREY_LIST", highRisk: true, sanctioned: false },
  { name: "Panama City", fatf: "NON_COMPLIANT", highRisk: true, sanctioned: false },
];

const PRODUCTS = ["Wire transfer", "Trade finance", "Correspondent"];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (min, max) => min + Math.random() * (max - min);
const round2 = (n) => Math.round(n * 100) / 100;

let sequence = Math.floor(Date.now() / 1000) % 100000;
const nextIds = () => {
  sequence += 1;
  return { transactionId: `9${sequence}`, alertId: `ALT-${sequence % 10000}` };
};

/* ------------------------------------------------------------ scenarios --- */

/**
 * A "shape" is the behavioural profile of the payment. It feeds both the model
 * features and the behavioural half of ruleInputs, so the two never disagree.
 */
function shapeFor(scenario) {
  switch (scenario) {
    case "sanctions":
      return { amountRatio: between(12, 20), count1h: 3, count24h: 11, valueRatio24h: between(18, 26),
               hoursSincePrevious: between(0.2, 0.8), newCounterparty: 1, newCountry: 1, unusualTime: 1 };
    case "structuring":
      return { amountRatio: between(1.2, 2.0), count1h: 5, count24h: 9, valueRatio24h: between(2.5, 4.5),
               hoursSincePrevious: between(0.1, 0.4), newCounterparty: 0, newCountry: 0, unusualTime: 1 };
    case "pep":
      return { amountRatio: between(6, 8), count1h: 1, count24h: 6, valueRatio24h: between(6, 9),
               hoursSincePrevious: between(2, 6), newCounterparty: 1, newCountry: 0, unusualTime: 0 };
    case "velocity":
      return { amountRatio: between(10, 14), count1h: 9, count24h: 22, valueRatio24h: between(52, 70),
               hoursSincePrevious: between(0.05, 0.3), newCounterparty: 1, newCountry: 0, unusualTime: 0 };
    case "model-down":
      return { amountRatio: between(3, 4), count1h: 0, count24h: 3, valueRatio24h: between(3.5, 5),
               hoursSincePrevious: between(18, 30), newCounterparty: 1, newCountry: 1, unusualTime: 0 };
    case "clean":
    default:
      return { amountRatio: between(0.8, 1.4), count1h: 0, count24h: 2, valueRatio24h: between(1.1, 1.8),
               hoursSincePrevious: between(12, 40), newCounterparty: 0, newCountry: 0, unusualTime: 0 };
  }
}

function complianceFor(scenario, company, destination) {
  const base = {
    sanctionsMatch: false,
    beneficialOwnerSanctionsMatch: false,
    destinationCountrySanctioned: false,
    destinationFatfStatus: destination.fatf,
    kycStatus: "APPROVED",
    kycExpired: false,
    pepExposure: false,
    highRiskIndustry: company.industryRisk,
    adverseMedia: false,
    structuringIndicator: false,
    rapidMovementIndicator: false,
  };

  switch (scenario) {
    case "sanctions":
      return { ...base, sanctionsMatch: true, pepExposure: true, adverseMedia: true, structuringIndicator: true };
    case "structuring":
      return { ...base, structuringIndicator: true, kycExpired: true, adverseMedia: true };
    case "pep":
      return { ...base, pepExposure: true, adverseMedia: true };
    case "velocity":
      return { ...base };
    case "model-down":
      return { ...base };
    case "clean":
    default:
      return { ...base, highRiskIndustry: false };
  }
}

function amountFor(scenario) {
  switch (scenario) {
    case "sanctions": return Math.round(between(2_000_000, 6_000_000) / 1000) * 1000;
    case "pep": return Math.round(between(900_000, 2_400_000));
    case "velocity": return Math.round(between(400_000, 1_200_000));
    case "structuring": return Math.round(between(9_000, 9_900));
    case "model-down": return Math.round(between(180_000, 400_000));
    default: return Math.round(between(20_000, 180_000));
  }
}

/* ------------------------------------------------------ payload assembly --- */

const FEATURE_PHRASES = {
  amount_ratio: "amount compared with the customer's normal amount",
  amount_zscore: "amount deviation from the customer's history",
  transaction_count_1h: "transaction frequency in the last hour",
  transaction_count_24h: "transaction frequency in the last 24 hours",
  value_ratio_24h: "daily transferred value compared with normal",
  hours_since_previous: "time since the previous transaction",
};

/** Mirrors the shape of score_row() in ai-core/narrow_ai/src/risk_anomaly/model.py. */
function syntheticAnomaly(features, modelVersion) {
  const raw =
    10 +
    3.0 * Math.min(features.amount_ratio, 15) +
    1.1 * Math.min(features.transaction_count_24h, 25) +
    0.9 * Math.min(features.value_ratio_24h, 30) +
    7 * features.is_new_counterparty +
    5 * features.is_new_country +
    4 * features.is_unusual_time;
  const anomalyScore = Math.max(5, Math.min(97, Math.round(raw + between(-4, 4))));

  const ranked = Object.entries(FEATURE_PHRASES)
    .map(([key, phrase]) => ({ key, phrase, magnitude: Number(features[key]) }))
    .sort((a, z) => z.magnitude - a.magnitude)
    .slice(0, 2)
    .map((d) => `Unusual ${d.phrase} (${d.magnitude.toFixed(2)})`);

  if (features.is_new_counterparty) ranked.push("New counterparty");
  else if (features.is_unusual_time) ranked.push("Unusual transaction time");

  return {
    anomalyScore,
    anomalyFlag: anomalyScore >= 95,
    anomalyBand: anomalyScore >= 95 ? "HIGH" : anomalyScore >= 70 ? "MEDIUM" : "LOW",
    modelVersion,
    flagThreshold: 95,
    topDeviations: ranked.slice(0, 3),
  };
}

/**
 * Weighted toward ordinary traffic. Real AML queues are mostly noise — that is
 * the whole reason triage ranking matters — so Criticals stay rare.
 * Roughly: 55% Low, 25% Watch, 15% High, 5% Critical.
 */
function weightedScenario() {
  const roll = Math.random();
  if (roll < 0.55) return "clean";
  if (roll < 0.73) return "structuring";
  if (roll < 0.81) return "velocity";
  if (roll < 0.88) return "pep";
  if (roll < 0.95) return "model-down";
  return "sanctions";
}

function buildRequest(scenarioName) {
  const scenario = scenarioName === "random" ? weightedScenario() : scenarioName;
  const company = pick(COMPANIES);
  // Corridor is pinned per scenario so the resulting tier is reproducible on stage.
  const greyList = DESTINATIONS.filter((d) => d.fatf === "GREY_LIST");
  const lowRisk = DESTINATIONS.filter((d) => !d.highRisk);
  const destination =
    scenario === "sanctions" ? pick(DESTINATIONS.filter((d) => d.highRisk))
    : scenario === "pep" || scenario === "model-down" ? pick(greyList)
    : scenario === "clean" || scenario === "velocity" ? pick(lowRisk)
    : pick(DESTINATIONS);

  const shape = shapeFor(scenario);
  const { transactionId, alertId } = nextIds();
  const amountUsd = amountFor(scenario);

  const modelFeatures = {
    transaction_id: transactionId,
    amount_ratio: round2(shape.amountRatio),
    amount_zscore: round2(Math.abs(shape.amountRatio - 1) * between(0.5, 0.9)),
    transaction_count_1h: shape.count1h,
    transaction_count_24h: shape.count24h,
    value_ratio_24h: round2(shape.valueRatio24h),
    hours_since_previous: round2(shape.hoursSincePrevious),
    is_new_counterparty: shape.newCounterparty,
    is_new_country: shape.newCountry,
    is_unusual_time: shape.unusualTime,
  };

  const compliance = complianceFor(scenario, company, destination);
  const ruleInputs = {
    ...compliance,
    destinationCountrySanctioned: destination.sanctioned,
    amountRatio: modelFeatures.amount_ratio,
    valueRatio24h: modelFeatures.value_ratio_24h,
    transactionCount1h: modelFeatures.transaction_count_1h,
    transactionCount24h: modelFeatures.transaction_count_24h,
    newCounterpartyLargeAmount: shape.newCounterparty === 1 && modelFeatures.amount_ratio >= 3,
    isUnusualTime: shape.unusualTime === 1,
    newHighRiskCountry: shape.newCountry === 1 && destination.highRisk,
    highValueRoundAmount: amountUsd >= 10_000 && amountUsd % 1000 === 0,
  };

  const body = {
    alertId,
    transactionId,
    ruleInputs,
    modelFeatures,
    transaction: {
      amountUsd,
      currency: "USD",
      originatorName: company.name,
      originatorCountry: company.country,
      destinationCountry: destination.name,
      productType: pick(PRODUCTS),
      initiatedAt: new Date().toISOString(),
    },
  };

  // model-down omits anomalyResult AND relies on AI Core being unreachable,
  // which is what produces the MODEL_UNAVAILABLE path in the response.
  if (!options.liveModel && scenario !== "model-down") {
    body.anomalyResult = syntheticAnomaly(modelFeatures, options.modelVersion);
  }

  return { scenario, body };
}

/* ------------------------------------------------------------------ run --- */

let warnedAboutPersistence = false;

async function send() {
  const { scenario, body } = buildRequest(options.scenario);

  let response;
  try {
    response = await fetch(`${API_BASE_URL}/api/risk-assessments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    console.error(`Could not reach the risk API at ${API_BASE_URL}. Is the backend running?`);
    console.error(error.message);
    process.exitCode = 1;
    return false;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`HTTP ${response.status}: ${payload.error ?? "unknown error"}`);
    process.exitCode = 1;
    return false;
  }

  if (payload.persistence !== "SAVED" && !warnedAboutPersistence) {
    warnedAboutPersistence = true;
    console.warn(
      "\n  Warning: persistence is UNAVAILABLE, so this alert will NOT appear in the dashboard.\n" +
        "  Check the HANA_* variables in backend/.env and run: npm run setup:assessment-store\n",
    );
  }

  if (options.quiet) {
    const a = payload.assessment;
    const anomaly = payload.scoreBreakdown.anomalyAvailable ? `${payload.scoreBreakdown.anomalyScore}` : "n/a";
    console.log(
      `${new Date().toLocaleTimeString("en-GB")}  ${payload.alertId}  ${String(a.overallScore).padStart(3)}  ` +
        `${a.riskLevel.padEnd(8)} rules ${String(payload.scoreBreakdown.ruleScore).padStart(3)} · anomaly ${anomaly.padStart(3)}  ` +
        `${a.hardOverride ? "OVERRIDE  " : ""}${scenario}  ${body.transaction.originatorName} → ${body.transaction.destinationCountry}` +
        `${payload.caseId ? `  case ${payload.caseId}` : ""}`,
    );
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
  return true;
}

async function main() {
  if (options.watch) {
    console.log(
      `Simulating "${options.scenario}" transactions every ${options.interval}ms against ${API_BASE_URL}.\n` +
        "Press Ctrl-C to stop.\n",
    );
    console.log("time      alert     score risk     composition                    scenario");
    console.log("─".repeat(110));
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const ok = await send();
      if (!ok) return;
      await new Promise((resolve) => setTimeout(resolve, options.interval));
    }
  }

  for (let i = 0; i < Math.max(1, options.count); i += 1) {
    const ok = await send();
    if (!ok) return;
    if (i < options.count - 1) {
      await new Promise((resolve) => setTimeout(resolve, options.interval));
    }
  }
}

await main();
