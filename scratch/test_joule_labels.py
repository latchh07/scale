import os
import sys
import json
from backend.joule_agent import process_joule_query

print("Testing Joule Agent Label Mapping...")

try:
    from backend.vectorembedding import get_hana_connection
    conn = get_hana_connection()
    cur = conn.cursor()
    cur.execute('SELECT TOP 1 ASSESSMENT_ID FROM "TEAM_12_USER"."RISK_ASSESSMENTS" ORDER BY GENERATED_AT DESC')
    row = cur.fetchone()
    if not row:
        print("No assessments found in DB!")
        sys.exit(1)
    
    latest_assessment_id = row[0]
    print(f"Using latest assessment ID: {latest_assessment_id}")
    
    test_ctx = {"assessment_id": latest_assessment_id}
    query = "Explain the risk drivers for this assessment."
    
    result = process_joule_query(query, test_ctx)
    
    print("\nResult:")
    print(json.dumps(result, indent=2))
    
    # Assert frontend labels are in risk_factors
    expected_labels = [
        "Amount risk",
        "Geographic risk",
        "Compliance & counterparty risk",
        "Transaction-pattern risk",
        "Velocity risk",
        "Other behavioural / industry risk"
    ]
    
    factors = result.get("risk_factors", [])
    factor_names = [f["name"] for f in factors]
    
    invalid = []
    for label in factor_names:
        if label not in expected_labels:
            invalid.append(label)
            
    if invalid:
        print(f"\n[FAIL] Found unexpected labels in output: {invalid}")
    else:
        print(f"\n[PASS] All {len(factor_names)} outputted frontend labels match perfectly!")

except Exception as e:
    print(f"Error: {e}")
