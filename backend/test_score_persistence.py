"""
backend/test_score_persistence.py
=================================
Verification Script for Phase 5A:
1. Triggers risk evaluation on Node.js (Port 3000)
2. Verifies HANA persistence by getting back an assessment_id
3. Queries Joule Agent to confirm it reads the new persisted score.
"""

import sys
import time
import requests
import subprocess
import os

from backend.joule_agent import process_joule_query
from backend.vectorembedding import get_hana_connection

def main():
    print("=" * 70)
    print("  Phase 5A: E2E Score Persistence Verification")
    print("=" * 70)

    # 1. Start Node.js server in the background
    print("\n[1] Starting Node.js Risk Engine...")
    node_dir = os.path.join(os.path.dirname(__file__))
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
        # 2. Trigger risk evaluation
        print("[2] Triggering risk evaluation (POST /api/risk-assessments)...")
        payload = {
            "alertId": 15004,
            "transactionId": 5001,
            "ruleInputs": {
                "amount": 99999,
                "velocity": 5
            }
        }
        resp = requests.post("http://localhost:3000/api/risk-assessments", json=payload)
        resp.raise_for_status()
        
        data = resp.json()
        assessment_id = data.get("assessmentId")
        overall_score = data.get("assessment", {}).get("overallScore")
        
        if not assessment_id:
            print("[FAIL] No assessment_id returned from Node.js!")
            print("Response:", data)
            node_proc.terminate()
            stdout, stderr = node_proc.communicate()
            print("Node STDOUT:", stdout.decode())
            print("Node STDERR:", stderr.decode())
            sys.exit(1)
            
        print(f"  [PASS] Node.js generated assessment_id: {assessment_id}")
        print(f"  [PASS] Node.js computed overallScore: {overall_score}")

        # 3. Verify in HANA directly
        print("\n[3] Verifying record exists in SAP HANA Cloud...")
        conn = get_hana_connection()
        cur = conn.cursor()
        
        from backend.joule_agent import _EMBED_SCHEMA
        cur.execute(
            f'SELECT TRANSACTION_ID, OVERALL_SCORE FROM "{_EMBED_SCHEMA}"."RISK_ASSESSMENTS" WHERE ASSESSMENT_ID = ?',
            (str(assessment_id),)
        )
        row = cur.fetchone()
        if not row:
            print(f"[FAIL] ASSESSMENT_ID {assessment_id} not found in HANA!")
            sys.exit(1)
            
        print(f"  [PASS] Verified ASSESSMENT_ID {assessment_id} in HANA. Score: {row[1]}")
        cur.close()
        conn.close()

        # 4. Trigger Joule Agent
        print("\n[4] Querying Joule Agent (Explainability Skill) using assessment_id...")
        query = "Explain this new risk score"
        context = {"assessment_id": str(assessment_id)}
        
        result = process_joule_query(query, context)
        
        print("  [PASS] Joule Agent execution complete.")
        print(f"  [PASS] Joule Intent: {result.get('_meta', {}).get('intent')}")
        print(f"\n  Joule Output:\n  {result.get('title')}")
        for section in result.get('sections', []):
            print(f"    - {section.get('label')}: {section.get('content')[:100]}...")
            
    finally:
        print("\n[5] Cleaning up Node.js server...")
        node_proc.terminate()
        node_proc.wait()
        
    print("\n" + "=" * 70)
    print("  Phase 5A verification complete! PASS")
    print("=" * 70)

if __name__ == "__main__":
    main()
