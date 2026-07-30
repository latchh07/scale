export async function fetchAnomalyResult(modelFeatures, options = {}) {
  const endpoint = options.endpoint ?? process.env.ANOMALY_SERVICE_URL;
  const bearerToken =
    options.bearerToken ?? process.env.ANOMALY_BEARER_TOKEN;

  if (!endpoint) {
    return null;
  }

  const headers = { "content-type": "application/json" };
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ data: modelFeatures }),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Anomaly service returned HTTP ${response.status}`);
  }

  return response.json();
}

