"""HTTP prediction service for local use and SAP AI Core deployment."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .features import FEATURES, select_and_validate_features
from .model import ModelBundle, load_bundle, score_row


class PredictionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transaction_id: str = Field(min_length=1)
    amount_ratio: float = Field(ge=0)
    amount_zscore: float = Field(ge=0)
    transaction_count_1h: float = Field(ge=0)
    transaction_count_24h: float = Field(ge=0)
    value_ratio_24h: float = Field(ge=0)
    hours_since_previous: float = Field(ge=0)
    is_new_counterparty: int = Field(ge=0, le=1)
    is_new_country: int = Field(ge=0, le=1)
    is_high_risk_country: int = Field(ge=0, le=1)
    is_unusual_time: int = Field(ge=0, le=1)


app = FastAPI(
    title="Team 12 Risk Anomaly API",
    version="0.1.0",
    description="Explainable anomaly signal for transaction alert triage.",
)


def model_path() -> Path:
    return Path(os.getenv("MODEL_PATH", "models/model.joblib"))


@lru_cache(maxsize=1)
def get_bundle() -> ModelBundle:
    path = model_path()
    if not path.exists():
        raise FileNotFoundError(str(path))
    return load_bundle(path)


@app.get("/health")
def health() -> dict[str, str]:
    path = model_path()
    return {
        "status": "ready" if path.exists() else "model_not_loaded",
        "modelPath": str(path),
    }


@app.post("/v1/predict")
def predict(request: PredictionRequest) -> dict:
    try:
        bundle = get_bundle()
    except (FileNotFoundError, TypeError) as exc:
        raise HTTPException(
            status_code=503, detail=f"Model is unavailable: {exc}"
        ) from exc

    payload = request.model_dump()
    transaction_id = payload.pop("transaction_id")
    row = select_and_validate_features(pd.DataFrame([payload], columns=FEATURES))
    result = score_row(bundle, row)
    return {"transactionId": transaction_id, **result}

