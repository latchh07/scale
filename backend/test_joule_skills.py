"""
backend/test_joule_skills.py
============================
Automated E2E Test Suite for the 5-skill Joule Agent via FastAPI.

Run:
  python backend/test_joule_skills.py
"""

from __future__ import annotations
import sys
import time
from fastapi.testclient import TestClient
from backend.main import app

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

def _c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if sys.stdout.isatty() else text

OK    = lambda s: _c(s, "32")
FAIL  = lambda s: _c(s, "31")
WARN  = lambda s: _c(s, "33")
BOLD  = lambda s: _c(s, "1")
DIM   = lambda s: _c(s, "2")

client = TestClient(app)

def run_test(label: str, query: str, context: dict = None) -> tuple[bool, float, str]:
    print(f"\n{'-'*65}")
    print(f"  {BOLD(label)}")
    print(f"  Query: {DIM(query)}")
    print(f"{'-'*65}")

    t0 = time.monotonic()
    payload = {"query": query}
    if context:
        payload["context"] = context
        if "alert_id" in context:
            payload["alert_id"] = str(context["alert_id"])
        if "case_id" in context:
            payload["case_id"] = str(context["case_id"])

    response = client.post("/api/joule/chat", json=payload)
    elapsed = (time.monotonic() - t0) * 1000

    if response.status_code != 200:
        print(f"  {FAIL('[FAIL]')} HTTP {response.status_code}: {response.text}")
        return False, elapsed, "HTTP Error"

    data = response.json()
    
    # Assert JSON schema
    if "title" not in data or "sections" not in data or "recommendation" not in data:
        print(f"  {FAIL('[FAIL]')} Missing required schema keys. Got: {list(data.keys())}")
        return False, elapsed, "Schema Error"
    
    if not isinstance(data["sections"], list):
        print(f"  {FAIL('[FAIL]')} 'sections' is not a list.")
        return False, elapsed, "Schema Error"

    print(f"  {OK('[PASS]')} Skill Executed: {data.get('_meta', {}).get('skill_executed')}")
    print(f"  {DIM('Title:')} {data['title']}")
    return True, elapsed, "OK"

def main():
    print("=" * 65)
    print(BOLD("  Phase 4B: E2E Skill Test Suite via FastAPI"))
    print("=" * 65)

    tests = [
        {
            "label": "1) Triage Queue",
            "query": "Show me the top high-risk cases in the triage queue",
            "ctx": {}
        },
        {
            "label": "2) Explainability",
            "query": "Why was alert 15004 flagged as critical?",
            "ctx": {"alert_id": "15004"}
        },
        {
            "label": "3) Screening Check",
            "query": "Run a screening check for sanctions and PEP hits on Global Nexus",
            "ctx": {"entity_name": "Global Nexus"}
        },
        {
            "label": "4) Case Assembly",
            "query": "Assemble case file and draft summary for case 10002",
            "ctx": {"case_id": "10002"}
        },
        {
            "label": "5) Aging/Escalation",
            "query": "Which cases are aging past 30 days and at risk of SLA breach?",
            "ctx": {}
        }
    ]

    results = []
    for tc in tests:
        ok, elapsed, detail = run_test(tc["label"], tc["query"], tc["ctx"])
        results.append((tc["label"], ok, elapsed, detail))

    print("\n" + "=" * 65)
    print(BOLD("  SUMMARY TABLE"))
    print("=" * 65)
    print(f"  {'Skill / Scenario':<25} {'Status':<10} {'ms':>8}")
    print(f"  {'-'*25} {'-'*10} {'-'*8}")
    passed = 0
    for label, ok, elapsed, detail in results:
        status = OK("PASS") if ok else FAIL("FAIL")
        print(f"  {label:<25} {status:<10} {elapsed:>8.0f}")
        if ok: passed += 1
    
    print(f"  {'-'*25} {'-'*10} {'-'*8}")
    print(f"  {BOLD('TOTAL')} {passed}/{len(tests)} passed\n")

if __name__ == "__main__":
    main()
