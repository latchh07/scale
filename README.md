# SCALE 2026 - Team 12

Shared implementation repository for the SCALE 2026 hackathon.

## SAP AI Core anomaly model

The predictive AI component is under [`ai-core/narrow_ai`](ai-core/narrow_ai).
It trains an explainable Isolation Forest model and serves a 0-100 transaction
anomaly score through SAP AI Core.

SAP AI Launchpad application settings:

- Resource group: `team-12`
- Revision: `main`
- Path in repository: `ai-core/narrow_ai/templates`
- Scenario: `scenario-risk-anomaly-team12`
- Training executable: `wt-risk-anomaly-team12`
- Serving executable: `st-risk-anomaly-team12`
- Docker image: `mgcxzzz/team12-risk-anomaly:latest`

Credentials, datasets, trained models and access tokens must never be committed.

## Risk assessment backend

The configurable rules and unified JSON API are under [`backend`](backend).
The policy is stored in `backend/config/risk-policy.json`, allowing the team to
change rule points, thresholds, risk bands and the rule/ML weighting without
rewriting application code.
