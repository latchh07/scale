# Frontend guide: Team 12 risk assessment

## What the frontend should call

The frontend must call the Team 12 backend, not SAP HANA or SAP AI Core
directly. The backend retrieves the transaction context from HANA, calculates
behavioural features, calls the deployed SAP AI Core model, applies the
explainable policy, and returns one safe JSON response.

```
POST {RISK_API_BASE_URL}/api/risk-assessments/from-transaction
```

Request body:

```json
{
  "transactionId": "5",
  "alertId": "optional-ui-alert-id"
}
```

`transactionId` is the HANA `TRANSACTION_ID`. `alertId` is optional and can be
used to associate the result with a frontend alert/card.

## Environment configuration

Never put HANA, SAP AI Core, or OAuth credentials in frontend code.

For a Vite/React frontend, create `.env.local`:

```env
VITE_RISK_API_BASE_URL=http://localhost:3000
```

Use the public backend URL instead when the frontend is deployed:

```env
VITE_RISK_API_BASE_URL=https://your-backend.example.com
```

## Fetch helper

```js
const API_BASE_URL = import.meta.env.VITE_RISK_API_BASE_URL;

export async function getRiskAssessment(transactionId, alertId) {
  const response = await fetch(
    `${API_BASE_URL}/api/risk-assessments/from-transaction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactionId: String(transactionId), alertId }),
    },
  );

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "Unable to assess transaction risk");
  }
  return payload;
}
```

Example usage:

```js
const [risk, setRisk] = useState(null);
const [loading, setLoading] = useState(false);
const [error, setError] = useState(null);

async function assessTransaction(transactionId) {
  setLoading(true);
  setError(null);
  try {
    setRisk(await getRiskAssessment(transactionId));
  } catch (err) {
    setError(err.message);
  } finally {
    setLoading(false);
  }
}
```

## Response fields to display

```json
{
  "assessment": {
    "overallScore": 43,
    "riskLevel": "MEDIUM",
    "recommendedAction": "STANDARD_REVIEW",
    "hardOverride": false
  },
  "scoreBreakdown": {
    "ruleScore": 45,
    "anomalyScore": 35,
    "ruleWeight": 0.8,
    "anomalyWeight": 0.2,
    "anomalyAvailable": true
  },
  "rulesTriggered": [],
  "hardOverrides": [],
  "modelSignals": {
    "modelVersion": "v3-chronological-holdout",
    "anomalyFlag": false,
    "anomalyBand": "LOW",
    "topDeviations": []
  },
  "featureSnapshot": {},
  "historyTransactionCount": 12
}
```

Recommended UI mapping:

| Response field | UI treatment |
| --- | --- |
| `assessment.overallScore` | Main 0–100 score/gauge |
| `assessment.riskLevel` | Colour badge: Low green, Medium amber, High red, Critical dark red |
| `assessment.recommendedAction` | Prominent next-action label |
| `rulesTriggered` | Explainability list: description and points |
| `hardOverrides` | Prominent compliance warning; never hide it behind a collapsed panel |
| `modelSignals.anomalyBand` | “Behavioural anomaly” badge, kept distinct from the overall risk badge |
| `modelSignals.topDeviations` | Plain-language model explanation |
| `featureSnapshot` | Optional technical-details drawer, not the default user view |

Treat `MODEL_UNAVAILABLE` as a visible but non-blocking state: show that the
assessment used explainable rules only, rather than displaying a fake model
score.

## Hosting choices

### Local demo on one laptop

1. Start the backend in `backend` with its private `.env` file.
2. Run the frontend on the same laptop.
3. Set `VITE_RISK_API_BASE_URL=http://localhost:3000`.

This is the quickest option for a live hackathon demo.

### Frontend hosted on ChatGPT Sites or another static host

ChatGPT Sites can host the frontend, but it does not make the local Node/HANA
backend publicly reachable. Deploy the backend separately to an approved SAP
BTP runtime, or temporarily expose it through a secure tunnel for a demo.

Then set `VITE_RISK_API_BASE_URL` to that HTTPS backend address and configure
the backend's `ALLOWED_ORIGIN` to the frontend's deployed origin instead of
`*`.

## Backend readiness checklist

The backend owner must ensure:

- the Node service is running and its `/health` endpoint returns `ready`;
- its `.env` contains HANA and AI Core credentials locally only;
- SAP AI Core deployment is running;
- the frontend can reach the configured API base URL;
- `ALLOWED_ORIGIN` matches the hosted frontend origin for public hosting.

The frontend should never receive database passwords, SAP AI Core client
secrets, OAuth tokens, or the raw HANA credentials ZIP.
