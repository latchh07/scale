"""SAP AI Core training entry point for the Team 12 anomaly model."""

from __future__ import annotations

import os
from pathlib import Path

import pandas as pd

from risk_anomaly.features import select_and_validate_features
from risk_anomaly.model import save_bundle, train_bundle


def main() -> None:
    data_dir = Path(os.getenv("DATA_DIR", "/app/data"))
    data_file = os.getenv("DATA_FILE", "risk_features.csv")
    source = data_dir / data_file
    output = Path(os.getenv("MODEL_OUT_DIR", "/app/model")) / "model.joblib"
    contamination = float(os.getenv("CONTAMINATION", "0.03"))
    model_version = os.getenv("MODEL_VERSION", "v1")

    if not source.exists():
        available = ", ".join(path.name for path in data_dir.glob("*.csv")) or "none"
        raise FileNotFoundError(
            f"Expected {source}. Available CSV files in {data_dir}: {available}"
        )

    print(f"Loading prepared risk features from {source}")
    frame = pd.read_csv(source)
    features = select_and_validate_features(frame)
    bundle = train_bundle(
        features,
        contamination=contamination,
        model_version=model_version,
    )
    save_bundle(bundle, output)
    print(
        f"Training successful: {len(features)} rows, "
        f"version={bundle.model_version}, output={output}"
    )


if __name__ == "__main__":
    main()
