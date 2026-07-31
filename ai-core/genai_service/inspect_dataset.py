import os
import sys
import pandas as pd

# Force UTF-8 output on Windows to avoid cp1252 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from dotenv import load_dotenv
from hdbcli import dbapi

# ── Load credentials ─────────────────────────────────────────────────────────
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..", "team_12.env"))

address  = os.getenv("HANA_ADDRESS") or os.getenv("HANA_HOST")
port     = int(os.getenv("HANA_PORT", 443))
user     = os.getenv("HANA_USER")
password = os.getenv("HANA_PASSWORD")
schema   = os.getenv("HANA_SCHEMA", user)          # default: same as username

# ── Connect ───────────────────────────────────────────────────────────────────
print("=" * 65)
print("  SAP HANA Cloud — Dataset Inspection")
print("=" * 65)
print(f"  Host   : {address}")
print(f"  User   : {user}   |   Schema hint: {schema}")
print("=" * 65)
print()

conn = dbapi.connect(
    address=address,
    port=port,
    user=user,
    password=password,
    encrypt=True,
    sslValidateCertificate=False,
    sslHostNameInCertificate="*",
)

cursor = conn.cursor()

# ── Helper ────────────────────────────────────────────────────────────────────
def section(title: str):
    print()
    print("-" * 65)
    print(f"  {title}")
    print("-" * 65)


def inspect_table(schema_name: str, table_name: str):
    """Load a sample of the table and print analysis."""
    full_name = f'"{schema_name}"."{table_name}"'
    section(f"TABLE: {schema_name}.{table_name}")

    # Row count
    cursor.execute(f"SELECT COUNT(*) FROM {full_name}")
    total_rows = cursor.fetchone()[0]
    print(f"  Total rows : {total_rows:,}")

    # Load up to 10 rows into pandas
    df = pd.read_sql(f"SELECT * FROM {full_name} LIMIT 10", conn)
    print(f"  Columns    : {len(df.columns)}")
    print()

    # Column info
    print("  -- Column Info ------------------------------------------")
    info_df = pd.DataFrame({
        "Column":   df.columns,
        "Dtype":    [str(d) for d in df.dtypes],
        "Non-Null": [df[c].notna().sum() for c in df.columns],
        "Sample":   [str(df[c].iloc[0])[:40] if len(df) > 0 else "N/A" for c in df.columns],
    })
    print(info_df.to_string(index=False))
    print()

    # Numeric summary
    numeric_cols = df.select_dtypes(include="number").columns.tolist()
    if numeric_cols:
        print("  -- Numeric Summary (describe) ---------------------------")
        print(df[numeric_cols].describe().to_string())
        print()

    # First 5 rows
    print("  -- First 5 Rows -----------------------------------------")
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 120)
    pd.set_option("display.max_colwidth", 30)
    print(df.head(5).to_string(index=False))


# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Look for tables in TEAM_12 schema (from env)
# ─────────────────────────────────────────────────────────────────────────────
section(f"Step 1: Tables in schema '{schema}'")
cursor.execute(
    "SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ? ORDER BY TABLE_NAME",
    (schema,),
)
team_tables = [row[0] for row in cursor.fetchall()]

if team_tables:
    print(f"  Found {len(team_tables)} table(s):\n")
    for t in team_tables:
        print(f"    • {t}")
    for t in team_tables:
        inspect_table(schema, t)
else:
    print(f"  No tables found in schema '{schema}'.")

    # ─────────────────────────────────────────────────────────────────────────
    # STEP 2 — Broaden search: all non-system schemas
    # ─────────────────────────────────────────────────────────────────────────
    section("Step 2: Searching all accessible non-system schemas")
    cursor.execute(
        """
        SELECT SCHEMA_NAME, TABLE_NAME
        FROM   SYS.TABLES
        WHERE  SCHEMA_NAME NOT LIKE 'SYS%'
          AND  SCHEMA_NAME NOT LIKE 'HDB%'
          AND  SCHEMA_NAME NOT LIKE '_SYS%'
          AND  TABLE_TYPE = 'TABLE'
        ORDER BY SCHEMA_NAME, TABLE_NAME
        LIMIT 30
        """,
    )
    found = cursor.fetchall()

    if found:
        print(f"  Found {len(found)} table(s) across accessible schemas:\n")
        current_schema = None
        for schema_name, table_name in found:
            if schema_name != current_schema:
                print(f"\n  SCHEMA: {schema_name}")
                current_schema = schema_name
            print(f"    • {table_name}")

        # Inspect each discovered table
        for schema_name, table_name in found:
            try:
                inspect_table(schema_name, table_name)
            except Exception as exc:
                print(f"  [WARN] Could not inspect {schema_name}.{table_name}: {exc}")
    else:
        print("  No accessible user tables found in any schema.")
        print("  The database appears to be empty / no SELECT privileges granted.")

# ── Done ──────────────────────────────────────────────────────────────────────
cursor.close()
conn.close()
print()
print("=" * 65)
print("  Inspection complete. Connection closed.")
print("=" * 65)
