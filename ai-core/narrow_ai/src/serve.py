"""KServe-compatible Flask service for SAP AI Core."""

from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
from flask import Flask, jsonify, request

from risk_anomaly.features import FEATURES, select_and_validate_features
from risk_anomaly.model import ModelBundle, load_bundle, score_row


app = Flask(__name__)
bundle: ModelBundle | None = None


def find_model() -> Path:
    model_dir = Path(os.getenv("MODEL_DIR", "/mnt/models"))
    direct = model_dir / "model.joblib"
    if direct.exists():
        return direct

    matches = list(model_dir.rglob("model.joblib"))
    if not matches:
        raise FileNotFoundError(f"model.joblib was not found under {model_dir}")
    return matches[0]


def init() -> None:
    global bundle
    model_path = find_model()
    print(f"Loading anomaly model from {model_path}")
    bundle = load_bundle(model_path)
    print(f"Model {bundle.model_version} loaded successfully")


@app.get("/health")
def health():
    return {
        "status": "ready" if bundle is not None else "model_not_loaded",
        "modelVersion": bundle.model_version if bundle else None,
    }


@app.post("/v1/models/risk-anomaly:infer")
def infer():
    if bundle is None:
        return jsonify({"error": "Model is unavailable"}), 503

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "Request body must be a JSON object"}), 400

    # Bruno/CAP may wrap the feature object in "data"; direct input also works.
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        return jsonify({"error": "data must be a JSON object"}), 400

    transaction_id = str(data.get("transaction_id", "unknown"))
    feature_payload = {name: data.get(name) for name in FEATURES}

    try:
        row = select_and_validate_features(pd.DataFrame([feature_payload]))
        result = score_row(bundle, row)
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({"transactionId": transaction_id, **result})


if __name__ == "__main__":
    init()
    app.run(host="0.0.0.0", debug=False, port=9001)
