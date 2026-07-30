# Team 12 SAP AI Core setup

This folder follows the supplied Narrow AI workshop structure while replacing
the spam classifier with the Team 12 transaction anomaly model.

## Before pushing to GitHub

1. Docker Hub image owner: `mgcxzzz`.
2. Build and push the image as:
   `mgcxzzz/team12-risk-anomaly:latest`.
   Verified Docker Hub digest:
   `sha256:97944663649f9a1d38a6f0e87390b8cc05d9f0b3d3f29c9385cec3feae7d91be`.
3. Do not copy object-store credentials, SAP service keys, `.env` files or
   generated models into this repository.
4. Keep the Bruno collection local. It is ignored because it can contain
   service credentials and temporary access tokens after configuration.

## Model input file

The training workflow expects the registered dataset artifact to contain:

`risk_features.csv`

It must contain at least 50 rows and these columns:

- `amount_ratio`
- `amount_zscore`
- `transaction_count_1h`
- `transaction_count_24h`
- `value_ratio_24h`
- `hours_since_previous`
- `is_new_counterparty`
- `is_new_country`
- `is_unusual_time`

The last three columns must contain only `0` or `1`. Known compliance facts
such as KYC risk, sanctions, PEP and adverse media are intentionally handled
by the deterministic rule engine rather than this behavioural anomaly model.

## SAP AI Launchpad values

- Resource group: `team-12`
- Application Git path: `narrow_ai/templates`
- Scenario: `scenario-risk-anomaly-team12`
- Training executable: `wt-risk-anomaly-team12`
- Training artifact assignment: `transaction-data`
- Training output: `risk-model-output`
- Serving executable: `st-risk-anomaly-team12`
- Serving artifact assignment: `modeluri`

Register the S3 file using an `ai://default/...` URL, following the object-store
prefix supplied for Team 12.

## Inference

POST to:

`<deployment-url>/v1/models/risk-anomaly:infer`

Example:

```json
{
  "data": {
    "transaction_id": "TX-001",
    "amount_ratio": 6.2,
    "amount_zscore": 5.4,
    "transaction_count_1h": 14,
    "transaction_count_24h": 32,
    "value_ratio_24h": 7.1,
    "hours_since_previous": 0.05,
    "is_new_counterparty": 1,
    "is_new_country": 1,
    "is_unusual_time": 1
  }
}
```

The response contains `anomalyScore`, `anomalyBand`, `anomalyFlag`,
`modelVersion` and `topDeviations`.
