"""Training, persistence and explainable anomaly scoring."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from .features import BINARY_FEATURES, FEATURE_LABELS, FEATURES


@dataclass
class ModelBundle:
    model: IsolationForest
    reference_scores: np.ndarray
    medians: dict[str, float]
    scales: dict[str, float]
    anomaly_flag_threshold: int
    model_version: str
    trained_at: str


def train_bundle(
    features: pd.DataFrame,
    *,
    contamination: float = 0.05,
    anomaly_flag_threshold: int = 95,
    model_version: str = "v1",
) -> ModelBundle:
    if len(features) < 50:
        raise ValueError("At least 50 historical transactions are required")
    if not 0 < contamination <= 0.5:
        raise ValueError("contamination must be greater than 0 and at most 0.5")
    if not 0 <= anomaly_flag_threshold <= 100:
        raise ValueError("anomaly_flag_threshold must be between 0 and 100")

    model = IsolationForest(
        n_estimators=200,
        contamination=contamination,
        random_state=42,
        n_jobs=-1,
    )
    model.fit(features)
    reference_scores = np.sort(-model.score_samples(features))

    medians = features.median().to_dict()
    q1 = features.quantile(0.25)
    q3 = features.quantile(0.75)
    scales = (q3 - q1).replace(0, 1.0).to_dict()

    return ModelBundle(
        model=model,
        reference_scores=reference_scores,
        medians={key: float(value) for key, value in medians.items()},
        scales={key: float(value) for key, value in scales.items()},
        anomaly_flag_threshold=int(anomaly_flag_threshold),
        model_version=model_version,
        trained_at=datetime.now(UTC).isoformat(),
    )


def save_bundle(bundle: ModelBundle, path: str | Path) -> None:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, destination)


def load_bundle(path: str | Path) -> ModelBundle:
    loaded = joblib.load(path)
    if not isinstance(loaded, ModelBundle):
        raise TypeError("The model file is not a compatible ModelBundle")
    return loaded


def score_row(bundle: ModelBundle, row: pd.DataFrame) -> dict[str, Any]:
    raw_score = float(-bundle.model.score_samples(row)[0])
    position = int(np.searchsorted(bundle.reference_scores, raw_score, side="right"))
    anomaly_score = int(round(100 * position / len(bundle.reference_scores)))
    anomaly_score = max(0, min(100, anomaly_score))

    reasons: list[tuple[float, str]] = []
    values = row.iloc[0]
    for feature in FEATURES:
        value = float(values[feature])
        if feature in BINARY_FEATURES:
            if value == 1:
                reasons.append((3.0, FEATURE_LABELS[feature].capitalize()))
            continue

        deviation = abs(value - bundle.medians[feature]) / bundle.scales[feature]
        if deviation >= 1.5:
            reasons.append(
                (
                    deviation,
                    f"Unusual {FEATURE_LABELS[feature]} ({value:.2f})",
                )
            )

    reasons.sort(key=lambda item: item[0], reverse=True)
    top_reasons = [reason for _, reason in reasons[:3]]
    if not top_reasons:
        top_reasons = ["No major individual feature deviation identified"]

    return {
        "anomalyScore": anomaly_score,
        "anomalyFlag": anomaly_score >= bundle.anomaly_flag_threshold,
        "anomalyBand": (
            "HIGH"
            if anomaly_score >= bundle.anomaly_flag_threshold
            else "MEDIUM"
            if anomaly_score >= 70
            else "LOW"
        ),
        "modelVersion": bundle.model_version,
        "flagThreshold": bundle.anomaly_flag_threshold,
        "topDeviations": top_reasons,
    }
