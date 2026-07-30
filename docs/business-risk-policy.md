# Team 12 transaction-risk policy

**Policy version:** 2.1.0  
**Purpose:** Provide an explainable, auditable transaction-risk assessment for
review prioritisation. The assessment combines fixed compliance/business rules
with an SAP AI Core behavioural-anomaly score.

## How the final score is calculated

1. Applicable rules add points to create a **rule score** (capped at 100).
2. The anomaly model provides a separate **behavioural score** from 0 to 100.
3. When the model is available, the final score is:

```text
Final score = (Rule score × 80%) + (Anomaly score × 20%)
```

4. A sanctions hard override takes precedence over the weighted result.

If the model is unavailable, the decision remains available using the rule
score alone; the response explicitly reports `MODEL_UNAVAILABLE`.

Points are not percentages. They are additive contributions to the rule score.
Within an exclusive group, only the highest applicable rule is counted.

## Risk bands and actions

| Final score | Risk level | Recommended action |
| ---: | --- | --- |
| 85–100 | Critical | Hold and escalate |
| 65–84 | High | Priority review |
| 35–64 | Medium | Standard review |
| 0–34 | Low | Monitor |

## Hard overrides

These controls override the normal weighted calculation.

| Condition | Minimum final score | Required outcome |
| --- | ---: | --- |
| Confirmed sanctions match for a transaction party | 100 | Critical; hold and escalate |
| Confirmed sanctions match for a beneficial owner | 100 | Critical; hold and escalate |
| Destination country is subject to sanctions | 95 | Critical; hold and escalate |

## Rule catalogue

### Geography and KYC

Only the highest applicable rule in each of these two groups is counted.

| Rule | Trigger | Points |
| --- | --- | ---: |
| FATF black list | Destination is on the FATF black list | 30 |
| FATF non-compliant | Destination is FATF non-compliant | 25 |
| FATF grey list | Destination is on the FATF grey list | 15 |
| KYC rejected | Customer KYC status is rejected | 30 |
| KYC expired | KYC was expired at the transaction time | 15 |
| KYC pending | Customer KYC status is pending | 10 |

### Customer and adverse-information context

| Rule | Trigger | Points |
| --- | --- | ---: |
| PEP exposure | Company or beneficial owner is PEP-associated | 20 |
| High-risk industry | Industry has high inherent AML risk/sensitivity | 5 |
| Adverse media | Adverse-media flag is present | 10 |

### Transaction behaviour

Only the highest applicable amount-deviation rule and highest applicable
daily-value rule are counted.

| Rule | Trigger | Points |
| --- | --- | ---: |
| Extreme amount deviation | Payment is at least 10× the customer's prior norm | 30 |
| High amount deviation | Payment is at least 5× the customer's prior norm | 20 |
| Elevated amount deviation | Payment is at least 3× the customer's prior norm | 10 |
| Extreme daily value | Trailing 24-hour value is at least 50× the prior norm | 25 |
| High daily value | Trailing 24-hour value is at least 30× the prior norm | 15 |
| Structuring pattern | Multiple near-threshold payments collectively exceed the threshold | 25 |
| New high-risk country | First payment to a high-risk destination country | 15 |
| New counterparty, large payment | First payment to the counterparty and payment is at least 3× normal | 10 |
| Unusual time | Payment occurred outside 06:00–22:00 UTC | 5 |
| High-value round amount | Payment is at least USD 10,000 and a round thousand amount | 10 |

### Reserved control

| Rule | Trigger | Points | Current status |
| --- | --- | ---: | --- |
| Rapid movement | Funds moved onward unusually quickly | 20 | Defined in policy but not yet activated because the current data flow does not calculate onward-fund movement reliably |

## Why the model and rules are kept separate

The model identifies behavioural deviations relative to the same company's
earlier activity: amount, frequency, counterparties, destinations and timing.
Rules cover deterministic compliance/context signals such as KYC, PEP, FATF,
sanctions and adverse media. This separation makes the result explainable and
ensures that a low behavioural anomaly score cannot hide a sanctions outcome.

## Sample API response

See `docs/sample-risk-assessment.json` for an illustrative response. Its sample
calculation is:

```text
Rule score = 85
Model score = 75
Final score = (85 × 0.80) + (75 × 0.20) = 83
Outcome = HIGH / PRIORITY_REVIEW
```

The sample is illustrative and contains no customer data.
