import os
import sys
from dotenv import load_dotenv
from hdbcli import dbapi

# Force UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# -- Load credentials ---------------------------------------------------------
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..", "team_12.env"))

address  = os.getenv("HANA_ADDRESS") or os.getenv("HANA_HOST")
port     = int(os.getenv("HANA_PORT", 443))
user     = os.getenv("HANA_USER")
password = os.getenv("HANA_PASSWORD")
schema   = os.getenv("HANA_SCHEMA", "TEAM_12")

# -- Connect ------------------------------------------------------------------
print("=" * 65)
print("  SAP HANA Cloud -- REAL_VECTOR Column Scan")
print("=" * 65)
print(f"  Host   : {address}")
print(f"  Schema : {schema}")
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

# -- Query SYS.TABLE_COLUMNS for REAL_VECTOR columns -------------------------
print("  SQL: SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE_NAME")
print("       FROM SYS.TABLE_COLUMNS")
print(f"       WHERE SCHEMA_NAME = '{schema}' AND DATA_TYPE_NAME = 'REAL_VECTOR'")
print()

cursor.execute(
    """
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE_NAME
    FROM   SYS.TABLE_COLUMNS
    WHERE  SCHEMA_NAME     = ?
      AND  DATA_TYPE_NAME  = 'REAL_VECTOR'
    ORDER BY TABLE_NAME, COLUMN_NAME
    """,
    (schema,),
)
rows = cursor.fetchall()

if rows:
    print(f"  Found {len(rows)} REAL_VECTOR column(s) in schema '{schema}':\n")
    print(f"  {'TABLE_NAME':<40} {'COLUMN_NAME':<30} DATA_TYPE")
    print(f"  {'-'*40} {'-'*30} ---------")
    for table_name, column_name, dtype in rows:
        print(f"  {table_name:<40} {column_name:<30} {dtype}")
else:
    print(
        "  No REAL_VECTOR columns found in TEAM_12 schema.\n"
        "  Current dataset consists purely of relational/structured data."
    )

# -- Bonus: show all distinct data types present in the schema ----------------
print()
print("-" * 65)
print("  All data types currently used in schema TEAM_12:")
print("-" * 65)
cursor.execute(
    """
    SELECT DATA_TYPE_NAME, COUNT(*) AS COLUMN_COUNT
    FROM   SYS.TABLE_COLUMNS
    WHERE  SCHEMA_NAME = ?
    GROUP BY DATA_TYPE_NAME
    ORDER BY COLUMN_COUNT DESC
    """,
    (schema,),
)
type_rows = cursor.fetchall()
if type_rows:
    print(f"  {'DATA_TYPE':<30} COUNT")
    print(f"  {'-'*30} -----")
    for dtype, count in type_rows:
        print(f"  {dtype:<30} {count}")
else:
    print("  (no columns found in schema)")

print()
print("=" * 65)
cursor.close()
conn.close()
