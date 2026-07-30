import { createServer } from "node:http";

import { fetchAnomalyResult } from "./anomaly-client.js";
import { loadTransactionContext } from "./hana-context.js";
import { calculateAssessment, loadPolicy } from "./risk-engine.js";

const policy = await loadPolicy();
const port = Number(process.env.PORT ?? 3000);
const allowedOrigin = process.env.ALLOWED_ORIGIN ?? "*";

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new Error("Request body exceeds 1 MB");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new Error("Request body is required");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      status: "ready",
      policyVersion: policy.policyVersion,
      anomalyServiceConfigured: Boolean(process.env.ANOMALY_SERVICE_URL),
    });
    return;
  }

  if (
    request.method === "POST" &&
    request.url === "/api/risk-assessments"
  ) {
    try {
      const payload = await readJson(request);
      if (!payload.alertId || !payload.transactionId) {
        sendJson(response, 400, {
          error: "alertId and transactionId are required",
        });
        return;
      }

      let anomalyResult = payload.anomalyResult ?? null;
      if (!anomalyResult && payload.modelFeatures) {
        try {
          anomalyResult = await fetchAnomalyResult(payload.modelFeatures);
        } catch (error) {
          console.error("Anomaly model unavailable:", error.message);
        }
      }

      const result = calculateAssessment({
        alertId: payload.alertId,
        transactionId: payload.transactionId,
        ruleInputs: payload.ruleInputs ?? {},
        anomalyResult,
        policy,
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (
    request.method === "POST" &&
    request.url === "/api/risk-assessments/from-transaction"
  ) {
    try {
      const payload = await readJson(request);
      if (!payload.transactionId) {
        sendJson(response, 400, { error: "transactionId is required" });
        return;
      }

      const context = await loadTransactionContext(payload.transactionId);
      let anomalyResult = null;
      try {
        anomalyResult = await fetchAnomalyResult(context.modelFeatures);
      } catch (error) {
        console.error("Anomaly model unavailable:", error.message);
      }

      const result = calculateAssessment({
        alertId: payload.alertId ?? null,
        transactionId: payload.transactionId,
        ruleInputs: context.ruleInputs,
        anomalyResult,
        policy,
      });
      sendJson(response, 200, {
        ...result,
        featureSnapshot: context.modelFeatures,
        historyTransactionCount: context.historyCount,
      });
    } catch (error) {
      const status = error.code === "TRANSACTION_NOT_FOUND" ? 404 : 400;
      sendJson(response, status, { error: error.message });
    }
    return;
  }

  sendJson(response, 404, { error: "Route not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Risk assessment API listening on port ${port}`);
});
