"""
backend/test_api_contracts.py
=============================
Tests strict Pydantic response models for /api/joule/chat and /api/investigate endpoints.
"""

from fastapi.testclient import TestClient
from backend.main import app
from backend.main import AnalysisResponse
from pydantic import ValidationError
import json

client = TestClient(app)

def test_investigate_contract():
    print("Testing /api/investigate endpoint contract...")
    # Trigger a real request (mocking or real, assuming alert_id 15004 exists)
    payload = {
        "alert_id": 15004,
        "query_context": "Test query for investigation",
        "top_k": 1,
        "enable_masking": False,
        "enable_filtering": False
    }
    
    response = client.post("/api/investigate", json=payload)
    if response.status_code != 200:
        print(f"[FAIL] /api/investigate returned {response.status_code}: {response.text}")
        return False
        
    data = response.json()
    try:
        # Validate against strict Pydantic model
        validated = AnalysisResponse(**data)
        print("[PASS] /api/investigate successfully returned a strictly validated AnalysisResponse!")
        print("  Title:", validated.title)
        print("  Sections:", len(validated.sections))
        print("  Risk Factors:", len(validated.risk_factors))
    except ValidationError as e:
        print("[FAIL] /api/investigate response failed strict validation:")
        print(e)
        return False
        
    return True

def test_joule_chat_contract():
    print("\nTesting /api/joule/chat endpoint contract...")
    payload = {
        "query": "Explain the risk score for alert 15004",
        "alert_id": "15004",
        "context": {}
    }
    
    response = client.post("/api/joule/chat", json=payload)
    if response.status_code != 200:
        print(f"[FAIL] /api/joule/chat returned {response.status_code}: {response.text}")
        return False
        
    data = response.json()
    try:
        # Validate against strict Pydantic model
        validated = AnalysisResponse(**data)
        print("[PASS] /api/joule/chat successfully returned a strictly validated AnalysisResponse!")
        print("  Title:", validated.title)
        print("  Sections:", len(validated.sections))
        print("  Risk Factors:", len(validated.risk_factors))
    except ValidationError as e:
        print("[FAIL] /api/joule/chat response failed strict validation:")
        print(e)
        return False
        
    return True

if __name__ == "__main__":
    print("=" * 60)
    print("  Phase 5B: API Contract Tests")
    print("=" * 60)
    
    success_investigate = test_investigate_contract()
    success_joule = test_joule_chat_contract()
    
    print("\n" + "=" * 60)
    if success_investigate and success_joule:
        print("  All Contract Tests Passed!")
    else:
        print("  Some Contract Tests Failed.")
    print("=" * 60)
