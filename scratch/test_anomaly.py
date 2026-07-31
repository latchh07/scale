import sys
import time
import requests
import subprocess
import os

from backend.joule_agent import process_joule_query

def main():
    print("=" * 70)
    print("  Anomaly Service E2E Verification")
    print("=" * 70)

    # 1. Start Node.js server
    print("\n[1] Starting Node.js Risk Engine...")
    node_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
    node_proc = subprocess.Popen(
        ["node", "src/server.js"],
        cwd=node_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    time.sleep(4)
    
    if node_proc.poll() is not None:
        print("[FAIL] Node.js server failed to start!")
        print(node_proc.stderr.read().decode())
        sys.exit(1)

    try:
        # 2. Trigger evaluation WITH modelFeatures to invoke anomaly inference
        print("[2] Triggering evaluation with modelFeatures (POST /api/risk-assessments)...")
        payload = {
            "alertId": 15006,
            "transactionId": 888124,
            "ruleInputs": {
                "destinationFatfStatus": "BLACK_LIST",
                "amountRatio": 12,
                "valueRatio24h": 60,
                "rapidMovementIndicator": True,
                "structuringIndicator": True,
                "pepExposure": True,
                "highValueRoundAmount": True,
                "kycStatus": "REJECTED"
            },
            "modelFeatures": {
                "transaction_id": "888124",
                "amount_ratio": 12.0,
                "amount_zscore": 6.4,
                "transaction_count_1h": 22,
                "transaction_count_24h": 45,
                "value_ratio_24h": 60.0,
                "hours_since_previous": 0.02,
                "is_new_counterparty": 1,
                "is_new_country": 1,
                "is_unusual_time": 1
            }
        }
        
        resp = requests.post("http://localhost:3000/api/risk-assessments", json=payload)
        
        if resp.status_code != 200:
            print("Failed API request:", resp.text)
            sys.exit(1)
            
        data = resp.json()
        assessment_id = data.get("assessmentId")
        model_signals = data.get("modelSignals", {})
        
        print(f"  [PASS] Node.js returned response successfully. Assessment ID: {assessment_id}")
        print("\n=== Anomaly Signals from SAP AI Core ===")
        import json
        print(json.dumps(model_signals, indent=2))
        
        if model_signals.get("status") == "MODEL_UNAVAILABLE" or model_signals.get("anomalyFlag") is None:
            print("\n[FAIL] Anomaly inference returned null or MODEL_UNAVAILABLE!")
            node_proc.terminate()
            stdout, stderr = node_proc.communicate()
            print("\n=== Node STDOUT ===")
            print(stdout.decode())
            print("\n=== Node STDERR ===")
            print(stderr.decode())
            sys.exit(1)
            
        print("  [PASS] Anomaly inference returned successful scores.")

        # 3. Query Joule Agent
        print(f"\n[3] Querying Joule Agent (Explainability Skill) for {assessment_id}...")
        query = "Explain this risk score"
        context = {"assessment_id": str(assessment_id)}
        
        result = process_joule_query(query, context)
        
        print("\n  [PASS] Joule Agent execution complete.")
        print(f"\n  Joule Output Title: {result.get('title')}")
        for section in result.get('sections', []):
            print(f"    - {section.get('label')}: {section.get('content')[:100]}...")
            if "Anomaly" in section.get('label'):
                if "unavailable" in section.get('content').lower():
                    print("      [FAIL] Joule agent thinks the model is unavailable.")
                    sys.exit(1)
                else:
                    print("      [PASS] Joule agent integrated anomaly scores!")
            
    finally:
        print("\n[4] Cleaning up Node.js server...")
        node_proc.terminate()
        node_proc.wait()

    print("\n" + "=" * 70)
    print("  Anomaly Service E2E Verification Complete! PASS")
    print("=" * 70)

if __name__ == "__main__":
    main()
