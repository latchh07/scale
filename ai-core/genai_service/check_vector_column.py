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

# -- Connect ------------------------------------------------------------------
print("=" * 65)
print("  SAP HANA Cloud -- Vector Engine Re-Test (COLUMN TABLE)")
print("=" * 65)
print(f"  Host : {address}")
print(f"  User : {user}")
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

# -- Test: CREATE LOCAL TEMPORARY COLUMN TABLE with REAL_VECTOR ---------------
print("  SQL: CREATE LOCAL TEMPORARY COLUMN TABLE #v_test (id INT, v REAL_VECTOR(3))")
print()
try:
    # Clean up from any previous run
    try:
        cursor.execute("DROP TABLE #v_test")
    except Exception:
        pass

    cursor.execute(
        "CREATE LOCAL TEMPORARY COLUMN TABLE #v_test (id INT, v REAL_VECTOR(3))"
    )
    print("  [OK] Table created successfully -- REAL_VECTOR is SUPPORTED on COLUMN tables.")

    # Bonus: insert a vector and verify round-trip
    cursor.execute(
        "INSERT INTO #v_test VALUES (1, TO_REAL_VECTOR('[0.1, 0.2, 0.3]'))"
    )
    print("  [OK] INSERT with TO_REAL_VECTOR(...) succeeded.")

    cursor.execute(
        "SELECT id, TO_NVARCHAR(v) AS v_str FROM #v_test"
    )
    row = cursor.fetchone()
    print(f"  [OK] SELECT result: id={row[0]}, v={row[1]}")

    cursor.execute("DROP TABLE #v_test")
    print()
    print("  RESULT: Vector Engine (REAL_VECTOR) -> SUPPORTED")

except Exception as exc:
    err = str(exc)
    print(f"  [FAIL] Exception: {err}")
    print()
    print("  RESULT: Vector Engine (REAL_VECTOR) -> NOT SUPPORTED / NOT ENABLED")
    print()
    print("  Possible reasons:")
    print("    - REAL_VECTOR requires the Vector Engine service unit to be")
    print("      enabled on the HANA Cloud instance (via BTP Cockpit).")
    print("    - The current user may lack the required privilege.")

print()
print("=" * 65)
cursor.close()
conn.close()
