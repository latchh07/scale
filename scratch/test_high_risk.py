import sys
import time
import requests
import subprocess
import os

from backend.vectorembedding import get_hana_connection

def main():
    print("[1] Starting Node.js Risk Engine...")
    node_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
    node_proc = subprocess.Popen(
        ["node", "src/server.js"],
        cwd=node_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    time.sleep(3) # Give it time to start and connect
    
    # Check if process is still running
    if node_proc.poll() is not None:
        print("[FAIL] Node.js server failed to start!")
        print(node_proc.stderr.read().decode())
        sys.exit(1)

    try:
        print("[2] Triggering high-risk evaluation (POST /api/risk-assessments)...")
        payload = {
            "alertId": 15005,
            "transactionId": 999123,
            "ruleInputs": {
                "destinationFatfStatus": "BLACK_LIST",
                "amountRatio": 12,
                "valueRatio24h": 60,
                "rapidMovementIndicator": True,
                "structuringIndicator": True,
                "pepExposure": True,
                "highValueRoundAmount": True,
                "kycStatus": "REJECTED"
            }
        }
        # The Node risk engine might expect specific keys in ruleInputs depending on the policy.
        # But even if it expects different ones, we can just supply these.
        
        resp = requests.post("http://localhost:3000/api/risk-assessments", json=payload)
        if resp.status_code != 200:
            print("Failed API request:", resp.text)
            sys.exit(1)
            
        data = resp.json()
        print(f"  [PASS] Node.js returned response successfully.")
        import json
        print(json.dumps(data, indent=2))
        
        print("\n[3] Verifying record exists in SAP HANA Cloud...")
        conn = get_hana_connection()
        cur = conn.cursor()
        
        # Note: The user's query asks for RISK_SCORE but our table uses OVERALL_SCORE
        assessment_id = data.get("assessmentId")
        cur.execute(
            'SELECT TRANSACTION_ID, OVERALL_SCORE, AMOUNT_RISK_SCORE, '
            'GEOGRAPHY_RISK_SCORE, VELOCITY_RISK_SCORE, PATTERN_RISK_SCORE, '
            'COUNTERPARTY_RISK_SCORE, FREQUENCY_RISK_SCORE '
            'FROM "TEAM_12_USER"."RISK_ASSESSMENTS" '
            'WHERE ASSESSMENT_ID = ?',
            (assessment_id,)
        )
        row = cur.fetchone()
        if not row:
            print(f"[FAIL] TRANSACTION_ID 999123 not found in HANA!")
            sys.exit(1)
            
        cols = [desc[0] for desc in cur.description]
        result = dict(zip(cols, row))
        
        print("\n=== HANA DB Record ===")
        for k, v in result.items():
            print(f"{k}: {v}")
            
    finally:
        print("\n[4] Cleaning up Node.js server...")
        node_proc.terminate()
        node_proc.wait()
        
if __name__ == "__main__":
    main()
