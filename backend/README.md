# Team 12 risk assessment backend

This service combines deterministic rule points with the SAP AI Core anomaly
signal and returns one auditable JSON assessment for the frontend and Joule.

## Change rules and weights

All current policy choices are in:

`config/risk-policy.json`

You can change:

- rule points and thresholds
- hard-override minimum scores
- rule/anomaly weights
- overall risk bands
- recommended actions

The two weights must add up to `1`. Run the tests after every policy change.

## Run locally

Requires Node.js 20 or newer. There are no third-party packages to install.

```powershell
npm test
npm start
```

Health:

`GET http://localhost:3000/health`

Assessment:

`POST http://localhost:3000/api/risk-assessments`

PowerShell example:

```powershell
$body = Get-Content examples/high-risk-request.json -Raw
Invoke-RestMethod -Uri http://localhost:3000/api/risk-assessments `
  -Method Post -ContentType "application/json" -Body $body
```

## Assess a HANA transaction directly

After configuring the HANA environment variables, call:

`POST /api/risk-assessments/from-transaction`

```json
{
  "transactionId": "<HANA transaction ID>",
  "alertId": "optional-alert-id"
}
```

The backend retrieves the transaction, uses only earlier transactions from the
same originator to build the nine behavioural features, retrieves KYC/owner/
country/industry context, calls AI Core, and returns one assessment JSON.
It never sends HANA identifiers, names, KYC, or sanctions data to the anomaly
model.

With the backend running, test any HANA transaction in one command:

```powershell
pnpm test:transaction -- 1
```

Optionally, give the result a specific alert ID:

```powershell
pnpm test:transaction -- 1 DEMO-001
```

The example supplies `anomalyResult` directly, which allows local development
before AI Core is deployed.

## Connect SAP AI Core

After deployment, set:

`ANOMALY_SERVICE_URL=<deployment-url>/v1/models/risk-anomaly:infer`

If no `anomalyResult` is supplied in the request, the backend sends
`modelFeatures` to that endpoint. If the model is unavailable, the assessment
falls back to a 100% rule score and reports `MODEL_UNAVAILABLE`.

For the hackathon deployment, replace the temporary bearer-token option with an
SAP BTP service binding or Destination so credentials are not stored in code.

## Consumer contract

Both the frontend and Joule should consume the backend response. They should not
calculate scores independently or call the anomaly model directly.
