"""Build the Team 12 anomaly-model feature dataset from SAP HANA."""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
from hdbcli import dbapi


REFERENCE_SCHEMA = "TRUSTSPHERE_REFERENCE"
FEATURE_COLUMNS = [
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


def credentials_from_zip(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        candidates = [
            name
            for name in archive.namelist()
            if name.endswith("team_12_credentials.json") and "__MACOSX" not in name
        ]
        if not candidates:
            raise ValueError("team_12_credentials.json was not found in the ZIP")
        return json.loads(archive.read(candidates[0]))["database"]


def load_settled_transactions(credentials_zip: Path) -> pd.DataFrame:
    db = credentials_from_zip(credentials_zip)
    connection = dbapi.connect(
        address=db["host"],
        port=int(db["port"]),
        user=db["username"],
        password=db["password"],
    )
    query = f"""
        SELECT
            T.TRANSACTION_ID,
            T.ORIGINATOR_COMPANY_ID,
            T.BENEFICIARY_COMPANY_ID,
            T.AMOUNT_USD,
            T.INITIATED_AT,
            T.DESTINATION_COUNTRY_ID
        FROM "{REFERENCE_SCHEMA}"."TRANSACTIONS" T
        WHERE T.STATUS = 'SETTLED'
        ORDER BY
            T.ORIGINATOR_COMPANY_ID,
            T.INITIATED_AT,
            T.TRANSACTION_ID
    """
    cursor = connection.cursor()
    cursor.execute(query)
    columns = [description[0] for description in cursor.description]
    frame = pd.DataFrame.from_records(cursor.fetchall(), columns=columns)
    cursor.close()
    connection.close()
    return frame


def add_window_features(frame: pd.DataFrame) -> pd.DataFrame:
    count_1h = np.zeros(len(frame), dtype=np.int64)
    count_24h = np.zeros(len(frame), dtype=np.int64)
    value_24h = np.zeros(len(frame), dtype=np.float64)
    one_hour_ns = int(pd.Timedelta(hours=1).value)
    one_day_ns = int(pd.Timedelta(hours=24).value)

    for positions in frame.groupby("ORIGINATOR_COMPANY_ID", sort=False).indices.values():
        positions = np.asarray(positions)
        times = frame.iloc[positions]["INITIATED_AT"].astype("int64").to_numpy()
        amounts = frame.iloc[positions]["AMOUNT_USD"].to_numpy(dtype=float)
        sequence = np.arange(len(positions))
        left_1h = np.searchsorted(times, times - one_hour_ns, side="left")
        left_24h = np.searchsorted(times, times - one_day_ns, side="left")
        cumulative = np.concatenate(([0.0], np.cumsum(amounts)))

        count_1h[positions] = sequence - left_1h
        count_24h[positions] = sequence - left_24h
        # Include the current transaction in the rolling transferred value.
        value_24h[positions] = cumulative[sequence + 1] - cumulative[left_24h]

    result = frame.copy()
    result["transaction_count_1h"] = count_1h
    result["transaction_count_24h"] = count_24h
    result["_value_24h"] = value_24h
    return result


def engineer_features(raw: pd.DataFrame) -> pd.DataFrame:
    frame = raw.copy()
    frame["INITIATED_AT"] = pd.to_datetime(frame["INITIATED_AT"], errors="raise")
    frame["AMOUNT_USD"] = pd.to_numeric(frame["AMOUNT_USD"], errors="raise")
    frame = frame.sort_values(
        ["ORIGINATOR_COMPANY_ID", "INITIATED_AT", "TRANSACTION_ID"]
    ).reset_index(drop=True)

    company_amount = frame.groupby("ORIGINATOR_COMPANY_ID")["AMOUNT_USD"]
    amount_median = company_amount.transform("median").clip(lower=1.0)
    amount_mean = company_amount.transform("mean")
    amount_std = company_amount.transform("std").replace(0, np.nan)
    global_std = max(float(frame["AMOUNT_USD"].std()), 1.0)

    frame["amount_ratio"] = frame["AMOUNT_USD"] / amount_median
    frame["amount_zscore"] = (
        (frame["AMOUNT_USD"] - amount_mean).abs() / amount_std.fillna(global_std)
    )

    frame = add_window_features(frame)
    frame["_transaction_day"] = frame["INITIATED_AT"].dt.floor("D")
    daily_value = frame.groupby(
        ["ORIGINATOR_COMPANY_ID", "_transaction_day"]
    )["AMOUNT_USD"].transform("sum")
    normal_daily_value = daily_value.groupby(frame["ORIGINATOR_COMPANY_ID"]).transform(
        "median"
    ).clip(lower=1.0)
    frame["value_ratio_24h"] = frame["_value_24h"] / normal_daily_value

    frame["hours_since_previous"] = (
        frame.groupby("ORIGINATOR_COMPANY_ID")["INITIATED_AT"]
        .diff()
        .dt.total_seconds()
        .div(3600)
        .fillna(168.0)
        .clip(lower=0, upper=720)
    )
    frame["is_new_counterparty"] = (
        ~frame.duplicated(
            ["ORIGINATOR_COMPANY_ID", "BENEFICIARY_COMPANY_ID"], keep="first"
        )
    ).astype(int)
    frame["is_new_country"] = (
        ~frame.duplicated(
            ["ORIGINATOR_COMPANY_ID", "DESTINATION_COUNTRY_ID"], keep="first"
        )
    ).astype(int)
    hour = frame["INITIATED_AT"].dt.hour
    frame["is_unusual_time"] = ((hour < 6) | (hour >= 22)).astype(int)

    result = frame[["TRANSACTION_ID", *FEATURE_COLUMNS]].copy()
    result = result.rename(columns={"TRANSACTION_ID": "transaction_id"})
    for column in FEATURE_COLUMNS:
        result[column] = pd.to_numeric(result[column], errors="raise")
    if not np.isfinite(result[FEATURE_COLUMNS].to_numpy(dtype=float)).all():
        raise ValueError("Generated feature data contains non-finite values")
    if (result[FEATURE_COLUMNS] < 0).any().any():
        raise ValueError("Generated feature data contains negative values")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    raw = load_settled_transactions(args.credentials)
    dataset = engineer_features(raw)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    dataset.to_csv(args.output, index=False, float_format="%.6f")
    print(f"Created {args.output} with {len(dataset)} rows and {len(dataset.columns)} columns")


if __name__ == "__main__":
    main()
