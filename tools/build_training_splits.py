"""Create chronological train, validation and test files for SAP AI Core."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

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
    "is_unusual_time",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--features", required=True, type=Path)
    parser.add_argument("--transactions", required=True, type=Path)
    parser.add_argument("--risk-scores", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    features = pd.read_csv(args.features)
    transactions = pd.read_csv(
        args.transactions,
        usecols=["TRANSACTION_ID", "INITIATED_AT", "STATUS"],
        low_memory=False,
    )
    scores = pd.read_csv(
        args.risk_scores,
        usecols=["TRANSACTION_ID", "IS_ANOMALY", "ANOMALY_TYPE"],
        low_memory=False,
    )

    required = ["transaction_id", *FEATURES]
    missing = [column for column in required if column not in features.columns]
    if missing:
        raise ValueError(f"Feature file is missing: {', '.join(missing)}")
    if features["transaction_id"].duplicated().any():
        raise ValueError("Feature file contains duplicate transaction IDs")

    metadata = transactions.merge(
        scores,
        on="TRANSACTION_ID",
        how="inner",
        validate="one_to_one",
    )
    metadata = metadata.loc[metadata["STATUS"].eq("SETTLED")].copy()
    combined = features.merge(
        metadata,
        left_on="transaction_id",
        right_on="TRANSACTION_ID",
        how="inner",
        validate="one_to_one",
    )
    if len(combined) != len(features):
        raise ValueError(
            f"Only {len(combined)} of {len(features)} feature rows matched settled metadata"
        )

    combined["initiated_at"] = pd.to_datetime(
        combined["INITIATED_AT"], errors="raise", utc=True
    )
    combined["is_anomaly"] = (
        combined["IS_ANOMALY"].astype(str).str.lower().eq("true").astype(int)
    )
    combined["anomaly_type"] = combined["ANOMALY_TYPE"].fillna("UNSPECIFIED")
    combined = combined.sort_values(
        ["initiated_at", "transaction_id"]
    ).reset_index(drop=True)

    train_end = int(len(combined) * 0.70)
    validation_end = int(len(combined) * 0.85)
    train = combined.iloc[:train_end]
    validation = combined.iloc[train_end:validation_end]
    test = combined.iloc[validation_end:]

    args.output_dir.mkdir(parents=True, exist_ok=True)
    train[required].to_csv(
        args.output_dir / "train.csv", index=False, float_format="%.6f"
    )
    evaluation_columns = [
        "transaction_id",
        "initiated_at",
        "is_anomaly",
        "anomaly_type",
        *FEATURES,
    ]
    validation[evaluation_columns].to_csv(
        args.output_dir / "validation.csv", index=False, float_format="%.6f"
    )
    test[evaluation_columns].to_csv(
        args.output_dir / "test.csv", index=False, float_format="%.6f"
    )

    manifest = {
        "split_strategy": "chronological_70_15_15",
        "total_rows": len(combined),
        "features": FEATURES,
        "train": {
            "rows": len(train),
            "start": train["initiated_at"].min().isoformat(),
            "end": train["initiated_at"].max().isoformat(),
        },
        "validation": {
            "rows": len(validation),
            "anomalies": int(validation["is_anomaly"].sum()),
            "start": validation["initiated_at"].min().isoformat(),
            "end": validation["initiated_at"].max().isoformat(),
        },
        "test": {
            "rows": len(test),
            "anomalies": int(test["is_anomaly"].sum()),
            "start": test["initiated_at"].min().isoformat(),
            "end": test["initiated_at"].max().isoformat(),
        },
    }
    (args.output_dir / "split_manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
