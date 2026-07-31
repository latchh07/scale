import os
import sys
import json
import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", "team_12.env"))

client_id = os.getenv("AICORE_CLIENT_ID")
client_secret = os.getenv("AICORE_CLIENT_SECRET")
auth_url = os.getenv("AICORE_AUTH_URL")
api_url = os.getenv("AICORE_API_URL")
resource_group = os.getenv("AICORE_RESOURCE_GROUP")

token_resp = requests.post(
    f"{auth_url}/oauth/token",
    data={"grant_type": "client_credentials"},
    auth=(client_id, client_secret)
)
token = token_resp.json()["access_token"]
headers = {
    "Authorization": f"Bearer {token}",
    "AI-Resource-Group": resource_group
}

dep_id = "dbdda8a49bd9a5dd"
base_url = f"{api_url}/v2/inference/deployments/{dep_id}"

paths = [
    "/health",
    "/ping",
    "/ready",
    "/v1/health",
    "/api/v1/health"
]

for path in paths:
    url = f"{base_url}{path}"
    print(f"Trying GET {url}...")
    try:
        resp = requests.get(url, headers=headers)
        print(f"  -> HTTP {resp.status_code}")
    except Exception as e:
        print("  -> Error:", e)

