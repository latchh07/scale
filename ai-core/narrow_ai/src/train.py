"""SAP AI Core training entry point with chronological holdout evaluation."""

from __future__ import annotations

import os
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    precision_recall_fscore_support,
    roc_auc_score,
)

from risk_anomaly.features import select_and_validate_features
from risk_anomaly.model import save_bundle, train_bundle


def labels(frame: pd.DataFrame) -> np.ndarray:
    if "is_anomaly" not in frame.columns:
        raise ValueError("Evaluation data requires an is_anomaly column")
    values = pd.to_numeric(frame["is_anomaly"], errors="raise").astype(int)
    if not values.isin([0, 1]).all():
        raise ValueError("is_anomaly must contain only 0 or 1")
    return values.to_numpy(dtype=bool)


def percentile_scores(bundle, features: pd.DataFrame) -> np.ndarray:
    raw_scores = -bundle.model.score_samples(features)
    positions = np.searchsorted(bundle.reference_scores, raw_scores, side="right")
    return np.clip(
        np.rint(100 * positions / len(bundle.reference_scores)), 0, 100
    ).astype(int)


def metrics_for(actual: np.ndarray, scores: np.ndarray, threshold: int) -> dict:
    predicted = scores >= threshold
    precision, recall, f1, _ = precision_recall_fscore_support(
        actual, predicted, average="binary", zero_division=0
    )
    tn, fp, fn, tp = confusion_matrix(
        actual, predicted, labels=[False, True]
    ).ravel()
    return {
        "threshold": int(threshold),
        "rows": int(len(actual)),
        "anomalies": int(actual.sum()),
        "alert_rate": float(predicted.mean()),
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "roc_auc": float(roc_auc_score(actual, scores)),
        "average_precision": float(average_precision_score(actual, scores)),
        "true_positive": int(tp),
        "false_positive": int(fp),
        "false_negative": int(fn),
        "true_negative": int(tn),
    }


def select_threshold(actual: np.ndarray, scores: np.ndarray) -> tuple[int, dict]:
    candidates = []
    for threshold in range(80, 100):
        result = metrics_for(actual, scores, threshold)
        if result["alert_rate"] <= 0.10:
            candidates.append(result)
    if not candidates:
        raise ValueError("No validation threshold satisfied the 10% alert-rate cap")
    best = max(
        candidates,
        key=lambda item: (item["f1"], item["precision"], item["recall"]),
    )
    return int(best["threshold"]), best


def main() -> None:
    data_dir = Path(os.getenv("DATA_DIR", "/app/data"))
    train_source = data_dir / os.getenv("TRAIN_FILE", "train.csv")
    validation_source = data_dir / os.getenv("VALIDATION_FILE", "validation.csv")
    test_source = data_dir / os.getenv("TEST_FILE", "test.csv")
    output_dir = Path(os.getenv("MODEL_OUT_DIR", "/app/model"))
    output = output_dir / "model.joblib"
    contamination = float(os.getenv("CONTAMINATION", "0.05"))
    model_version = os.getenv("MODEL_VERSION", "v1")

    required_files = [train_source, validation_source, test_source]
    missing_files = [str(path) for path in required_files if not path.exists()]
    if missing_files:
        available = ", ".join(path.name for path in data_dir.glob("*.csv")) or "none"
        raise FileNotFoundError(
            f"Missing required files: {', '.join(missing_files)}. "
            f"Available CSV files in {data_dir}: {available}"
        )

    print("Loading chronological train, validation and test datasets")
    train_frame = pd.read_csv(train_source)
    validation_frame = pd.read_csv(validation_source)
    test_frame = pd.read_csv(test_source)
    train_features = select_and_validate_features(train_frame)
    validation_features = select_and_validate_features(validation_frame)
    test_features = select_and_validate_features(test_frame)

    evaluation_bundle = train_bundle(
        train_features,
        contamination=contamination,
        model_version=model_version,
    )
    validation_scores = percentile_scores(evaluation_bundle, validation_features)
    threshold, validation_metrics = select_threshold(
        labels(validation_frame), validation_scores
    )
    test_scores = percentile_scores(evaluation_bundle, test_features)
    test_metrics = metrics_for(labels(test_frame), test_scores, threshold)

    final_features = pd.concat(
        [train_features, validation_features], ignore_index=True
    )
    bundle = train_bundle(
        final_features,
        contamination=contamination,
        anomaly_flag_threshold=threshold,
        model_version=model_version,
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    save_bundle(bundle, output)
    report = {
        "model_version": model_version,
        "algorithm": "IsolationForest",
        "contamination": contamination,
        "split_strategy": "chronological_70_15_15",
        "final_training_rows": len(final_features),
        "selected_anomaly_threshold": threshold,
        "validation": validation_metrics,
        "test": test_metrics,
    }
    (output_dir / "metrics.json").write_text(
        json.dumps(report, indent=2), encoding="utf-8"
    )
    print(
        f"Training successful: final_rows={len(final_features)}, "
        f"threshold={threshold}, test_f1={test_metrics['f1']:.4f}, "
        f"version={bundle.model_version}, output={output}"
    )


if __name__ == "__main__":
    main()
