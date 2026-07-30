let accessTokenCache = null;

async function getBearerToken(options) {
  if (options.bearerToken ?? process.env.ANOMALY_BEARER_TOKEN) {
    return options.bearerToken ?? process.env.ANOMALY_BEARER_TOKEN;
  }

  const authUrl = options.authUrl ?? process.env.AI_AUTH_URL;
  const clientId = options.clientId ?? process.env.AI_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.AI_CLIENT_SECRET;
  if (!authUrl || !clientId || !clientSecret) return null;
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 30_000) {
    return accessTokenCache.token;
  }

  const response = await fetch(`${authUrl.replace(/\/$/, "")}/oauth/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`AI Core authentication returned HTTP ${response.status}`);
  }
  const token = await response.json();
  accessTokenCache = {
    token: token.access_token,
    expiresAt: Date.now() + Number(token.expires_in ?? 300) * 1000,
  };
  return accessTokenCache.token;
}

export async function fetchAnomalyResult(modelFeatures, options = {}) {
  const endpoint = options.endpoint ?? process.env.ANOMALY_SERVICE_URL;

  if (!endpoint) {
    return null;
  }

  const headers = { "content-type": "application/json" };
  const bearerToken = await getBearerToken(options);
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }
  const resourceGroup = options.resourceGroup ?? process.env.AI_RESOURCE_GROUP;
  if (resourceGroup) headers["AI-Resource-Group"] = resourceGroup;

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
