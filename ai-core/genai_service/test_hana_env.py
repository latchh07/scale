import os
from dotenv import load_dotenv
from hdbcli import dbapi

# Load environment variables from .env file (searches upward from script location)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", "..", "team_12.env"))

# Read credentials from environment variables
# Supports both HANA_ADDRESS and HANA_HOST for flexibility
address = os.getenv("HANA_ADDRESS") or os.getenv("HANA_HOST")
port = int(os.getenv("HANA_PORT", 443))
user = os.getenv("HANA_USER")
password = os.getenv("HANA_PASSWORD")

print("=== SAP HANA Cloud Connection Test ===")
print(f"  Host    : {address}")
print(f"  Port    : {port}")
print(f"  User    : {user}")
print(f"  Password: {'*' * len(password) if password else 'NOT SET'}")
print()

# Establish connection
# Note: sslValidateCertificate must be passed as string 'false' in some hdbcli versions
conn = dbapi.connect(
    address=address,
    port=port,
    user=user,
    password=password,
    encrypt=True,
    sslValidateCertificate=False,
    sslHostNameInCertificate="*",
)

print("Connected successfully to SAP HANA Cloud!")
print()

# --- Test query 1: SELECT * FROM DUMMY ---
cursor = conn.cursor()
cursor.execute("SELECT * FROM DUMMY")
rows = cursor.fetchall()
print("Query: SELECT * FROM DUMMY")
print(f"Result: {rows}")
print()

# --- Test query 2: List available tables in current schema ---
cursor.execute(
    """
    SELECT TABLE_NAME, TABLE_TYPE
    FROM SYS.TABLES
    WHERE SCHEMA_NAME = CURRENT_USER
    ORDER BY TABLE_NAME
    LIMIT 20
    """
)
tables = cursor.fetchall()
print("Available tables in current schema:")
if tables:
    for table_name, table_type in tables:
        print(f"  [{table_type}] {table_name}")
else:
    print("  (no tables found in current schema)")

cursor.close()
conn.close()
print()
print("Connection closed.")
