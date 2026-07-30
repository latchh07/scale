const transactionId = process.argv[2];
const alertId = process.argv[3] ?? `DEMO-${transactionId ?? "TRANSACTION"}`;
const apiBaseUrl = (process.env.RISK_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

if (!transactionId) {
  console.error("Usage: pnpm test:transaction -- <transactionId> [alertId]");
  process.exit(1);
}

try {
  const response = await fetch(`${apiBaseUrl}/api/risk-assessments/from-transaction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transactionId, alertId }),
  });

  const payload = await response.json();
  console.log(JSON.stringify(payload, null, 2));

  if (!response.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Could not reach the risk API at ${apiBaseUrl}. Is the backend running?`);
  console.error(error.message);
  process.exitCode = 1;
}
