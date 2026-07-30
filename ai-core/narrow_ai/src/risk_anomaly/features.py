"""Feature contract and validation for transaction anomaly scoring."""

from __future__ import annotations

import numpy as np
import pandas as pd


FEATURES = [
    "amount_ratio",
    "amount_zscore",
    "transaction_count_1h",
    "transaction_count_24h",
    "value_ratio_24h",
    "hours_since_previous",
    "is_new_counterparty",
    "is_new_country",
    "is_high_risk_country",
    "is_unusual_time",
]

BINARY_FEATURES = {
    "is_new_counterparty",
    "is_new_country",
    "is_high_risk_country",
    "is_unusual_time",
}

FEATURE_LABELS = {
    "amount_ratio": "amount compared with the customer's normal amount",
    "amount_zscore": "amount deviation from the customer's history",
    "transaction_count_1h": "transaction frequency in the last hour",
    "transaction_count_24h": "transaction frequency in the last 24 hours",
    "value_ratio_24h": "daily transferred value compared with normal",
    "hours_since_previous": "time since the previous transaction",
    "is_new_counterparty": "new counterparty",
    "is_new_country": "new destination country",
    "is_high_risk_country": "high-risk destination country",
    "is_unusual_time": "unusual transaction time",
}


def select_and_validate_features(frame: pd.DataFrame) -> pd.DataFrame:
    """Return finite numeric model features in the agreed column order."""
    missing = [column for column in FEATURES if column not in frame.columns]
    if missing:
        raise ValueError(f"Missing required feature columns: {', '.join(missing)}")

    result = frame[FEATURES].copy()
    for column in FEATURES:
        result[column] = pd.to_numeric(result[column], errors="coerce")

    invalid = result.isna() | ~np.isfinite(result)
    if invalid.any().any():
        bad_columns = invalid.columns[invalid.any()].tolist()
        raise ValueError(
            "Features must be finite numeric values. Invalid columns: "
            + ", ".join(bad_columns)
        )

    for column in BINARY_FEATURES:
        if not result[column].isin([0, 1]).all():
            raise ValueError(f"{column} must contain only 0 or 1")

    if (result < 0).any().any():
        bad_columns = result.columns[(result < 0).any()].tolist()
        # amount_zscore is stored as an absolute deviation in this contract.
        raise ValueError(
            "Features must be non-negative. Invalid columns: "
            + ", ".join(bad_columns)
        )

    return result.astype(float)

