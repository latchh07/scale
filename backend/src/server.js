import { createServer } from "node:http";

import { fetchAnomalyResult } from "./anomaly-client.js";
import {
  listAssessmentSummaries,
  loadAssessment,
  persistAssessment,
} from "./assessment-store.js";
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

  const requestUrl = new URL(request.url, "http://localhost");
  if (request.method === "GET" && requestUrl.pathname === "/api/risk-assessments/history") {
    try {
      const assessments = await listAssessmentSummaries(requestUrl.searchParams.get("limit"));
      sendJson(response, 200, { assessments });
    } catch (error) {
      sendJson(response, 500, { error: `Could not load assessment history: ${error.message}` });
    }
    return;
  }

  const historyMatch = requestUrl.pathname.match(/^\/api\/risk-assessments\/history\/([0-9a-f-]{36})$/i);
  if (request.method === "GET" && historyMatch) {
    try {
      const assessment = await loadAssessment(historyMatch[1]);
      if (!assessment) {
        sendJson(response, 404, { error: "Assessment not found" });
      } else {
        sendJson(response, 200, assessment);
      }
    } catch (error) {
      sendJson(response, 500, { error: `Could not load assessment: ${error.message}` });
    }
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
      try {
        const savedAssessment = await persistAssessment({
          assessment: result,
          featureSnapshot: payload.modelFeatures ?? null,
          sourceCaseId: payload.sourceCaseId ?? null,
        });
        sendJson(response, 200, { ...result, ...savedAssessment, persistence: "SAVED" });
      } catch (error) {
        console.error("Assessment persistence unavailable:", error.message);
        sendJson(response, 200, { ...result, persistence: "UNAVAILABLE" });
      }
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
      const responsePayload = {
        ...result,
        featureSnapshot: context.modelFeatures,
        historyTransactionCount: context.historyCount,
      };
      try {
        const savedAssessment = await persistAssessment({
          assessment: responsePayload,
          featureSnapshot: context.modelFeatures,
          sourceCaseId: payload.sourceCaseId ?? null,
        });
        sendJson(response, 200, { ...responsePayload, ...savedAssessment, persistence: "SAVED" });
      } catch (error) {
        console.error("Assessment persistence unavailable:", error.message);
        sendJson(response, 200, { ...responsePayload, persistence: "UNAVAILABLE" });
      }
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
