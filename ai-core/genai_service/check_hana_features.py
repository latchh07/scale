import os
import sys
from dotenv import load_dotenv
from hdbcli import dbapi

# Force UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Load credentials ──────────────────────────────────────────────────────────
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..", "team_12.env"))

address  = os.getenv("HANA_ADDRESS") or os.getenv("HANA_HOST")
port     = int(os.getenv("HANA_PORT", 443))
user     = os.getenv("HANA_USER")
password = os.getenv("HANA_PASSWORD")

# ── Connect ───────────────────────────────────────────────────────────────────
print("=" * 65)
print("  SAP HANA Cloud -- Feature Capability Check")
print("=" * 65)
print(f"  Host : {address}")
print(f"  User : {user}")
print("=" * 65)

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

results = {}  # feature -> (supported: bool, detail: str)

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE 1 — Native Vector Engine  (REAL_VECTOR type)
# ─────────────────────────────────────────────────────────────────────────────
print()
print("-" * 65)
print("  [1] Testing: Native Vector Engine (REAL_VECTOR)")
print("-" * 65)

# First try creating a local temp table with REAL_VECTOR column
try:
    # Drop in case it already exists from a previous run
    try:
        cursor.execute("DROP TABLE #v_test")
    except Exception:
        pass

    cursor.execute("CREATE LOCAL TEMPORARY TABLE #v_test (v REAL_VECTOR(3))")
    print("  CREATE LOCAL TEMPORARY TABLE #v_test (v REAL_VECTOR(3))  -> OK")

    # Also try inserting a vector value and doing a similarity search
    cursor.execute("INSERT INTO #v_test VALUES (TO_REAL_VECTOR('[1.0, 2.0, 3.0]'))")
    print("  INSERT with TO_REAL_VECTOR(...)                          -> OK")

    cursor.execute(
        "SELECT COSINE_SIMILARITY(v, TO_REAL_VECTOR('[1.0, 2.0, 3.0]')) AS sim "
        "FROM #v_test"
    )
    sim_row = cursor.fetchone()
    similarity = round(sim_row[0], 6) if sim_row else "N/A"
    print(f"  COSINE_SIMILARITY(...)                                   -> {similarity}")

    cursor.execute("DROP TABLE #v_test")
    results["REAL_VECTOR / Vector Engine"] = (True, f"COSINE_SIMILARITY returned {similarity}")

except Exception as exc:
    err = str(exc)
    print(f"  ERROR: {err}")
    results["REAL_VECTOR / Vector Engine"] = (False, err)

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE 2 — Knowledge Graph / SPARQL (Triple Store)
# ─────────────────────────────────────────────────────────────────────────────
print()
print("-" * 65)
print("  [2] Testing: Knowledge Graph Engine (SPARQL / Triple Store)")
print("-" * 65)

sparql_query = "SELECT * FROM SPARQL ('SELECT ?s WHERE { ?s ?p ?o } LIMIT 1')"
try:
    cursor.execute(sparql_query)
    rows = cursor.fetchall()
    col_names = [desc[0] for desc in cursor.description]
    print(f"  SPARQL SELECT executed successfully.")
    print(f"  Columns returned : {col_names}")
    print(f"  Rows returned    : {len(rows)}")
    if rows:
        print(f"  First row        : {rows[0]}")
    else:
        print("  (Triple store appears empty — no triples found)")
    results["SPARQL / Knowledge Graph"] = (True, f"{len(rows)} row(s) returned")

except Exception as exc:
    err = str(exc)
    print(f"  ERROR: {err}")
    results["SPARQL / Knowledge Graph"] = (False, err)

# ─────────────────────────────────────────────────────────────────────────────
# FEATURE 3 — Bonus: Check HANA version & edition for context
# ─────────────────────────────────────────────────────────────────────────────
print()
print("-" * 65)
print("  [3] HANA Instance Version Info")
print("-" * 65)
try:
    cursor.execute("SELECT VERSION FROM SYS.M_DATABASE")
    version = cursor.fetchone()[0]
    print(f"  DB Version : {version}")
    results["HANA Version"] = (True, version)
except Exception as exc:
    print(f"  Could not retrieve version: {exc}")

try:
    cursor.execute(
        "SELECT SYSTEM_ID, DATABASE_NAME, USAGE FROM SYS.M_DATABASE"
    )
    row = cursor.fetchone()
    if row:
        print(f"  System ID  : {row[0]}")
        print(f"  DB Name    : {row[1]}")
        print(f"  Usage      : {row[2]}")
except Exception as exc:
    print(f"  Could not retrieve DB metadata: {exc}")

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
print()
print("=" * 65)
print("  RESULTS SUMMARY")
print("=" * 65)
for feature, (supported, detail) in results.items():
    status = "  SUPPORTED    " if supported else "  NOT SUPPORTED"
    print(f"  {status}  |  {feature}")
    print(f"               |    -> {detail[:80]}")
    print()
print("=" * 65)

cursor.close()
conn.close()
