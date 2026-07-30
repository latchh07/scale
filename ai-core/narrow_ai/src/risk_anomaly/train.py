"""Command-line entry point for training the Isolation Forest."""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from .features import select_and_validate_features
from .model import save_bundle, train_bundle


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train transaction anomaly model")
    parser.add_argument("--input", required=True, help="Prepared feature CSV")
    parser.add_argument(
        "--output", default="models/model.joblib", help="Destination model file"
    )
    parser.add_argument("--contamination", type=float, default=0.03)
    parser.add_argument("--model-version", default="v1")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    source = Path(args.input)
    if not source.exists():
        raise FileNotFoundError(f"Training data not found: {source}")

    frame = pd.read_csv(source)
    features = select_and_validate_features(frame)
    bundle = train_bundle(
        features,
        contamination=args.contamination,
        model_version=args.model_version,
    )
    save_bundle(bundle, args.output)
    print(
        f"Saved {bundle.model_version} to {args.output}; "
        f"trained on {len(features)} transactions at {bundle.trained_at}"
    )


if __name__ == "__main__":
    main()

