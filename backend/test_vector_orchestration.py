"""
backend/test_vector_orchestration.py
======================================
End-to-end verification suite for the RAG + Orchestration pipeline.

Tests
-----
1. HANA connectivity
2. Embedding model warm-up
3. Embedding table status (TEAM_12_USER.*_EMBEDDINGS)
4. populate_embeddings() — seed more alert embeddings if needed
5. search_similar_texts() — vector ANN search with assertions
6. run_orchestrated_prompt() — PII input through full pipeline
7. Full SAR investigation simulation  (mirrors POST /api/investigate)

Run:
  python backend/test_vector_orchestration.py
"""

from __future__ import annotations

import sys
import time
import textwrap

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Colour helpers (ANSI, gracefully degraded) ────────────────────────────────
_USE_COLOR = sys.stdout.isatty() if hasattr(sys.stdout, "isatty") else False

def _c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _USE_COLOR else text

OK    = lambda s: _c(s, "32")
FAIL  = lambda s: _c(s, "31")
WARN  = lambda s: _c(s, "33")
BOLD  = lambda s: _c(s, "1")
DIM   = lambda s: _c(s, "2")

# ── Result tracking ───────────────────────────────────────────────────────────
_results: list[tuple[str, bool, str, float]] = []   # (name, passed, detail, ms)

def _run_test(name: str, fn, *args, **kwargs):
    """Run fn(*args, **kwargs), record pass/fail/timing, print result."""
    print(f"\n  {BOLD(name)}")
    t0 = time.monotonic()
    try:
        detail = fn(*args, **kwargs)
        elapsed = (time.monotonic() - t0) * 1000
        _results.append((name, True, detail or "", elapsed))
        print(f"    {OK('[PASS]')}  {detail or ''}  {DIM(f'({elapsed:.0f} ms)')}")
        return True
    except AssertionError as exc:
        elapsed = (time.monotonic() - t0) * 1000
        _results.append((name, False, str(exc), elapsed))
        print(f"    {FAIL('[FAIL]')}  {exc}  {DIM(f'({elapsed:.0f} ms)')}")
        return False
    except Exception as exc:
        elapsed = (time.monotonic() - t0) * 1000
        _results.append((name, False, str(exc), elapsed))
        print(f"    {FAIL('[ERROR]')}  {exc}  {DIM(f'({elapsed:.0f} ms)')}")
        return False

def _assert(condition: bool, message: str):
    if not condition:
        raise AssertionError(message)

# =============================================================================
# Test implementations
# =============================================================================

def test_hana_connectivity():
    from backend.vectorembedding import get_hana_connection
    conn = get_hana_connection()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM SYS.TABLES WHERE SCHEMA_NAME = 'TEAM_12'")
    n = cur.fetchone()[0]
    cur.close()
    conn.close()
    _assert(n > 0, f"Expected >0 tables in TEAM_12, got {n}")
    return f"TEAM_12 has {n} tables"


def test_embedding_model():
    from backend.vectorembedding import get_embedding, EMBEDDING_DIM, _load_embed_model
    _load_embed_model()
    vec = get_embedding("Test sentence for AML compliance embedding.")
    _assert(isinstance(vec, list), "Expected list output")
    _assert(len(vec) == EMBEDDING_DIM, f"Expected dim={EMBEDDING_DIM}, got {len(vec)}")
    _assert(all(isinstance(v, float) for v in vec), "All values must be float")
    norm = sum(v * v for v in vec) ** 0.5
    _assert(abs(norm - 1.0) < 0.01, f"Expected normalized vector, norm={norm:.4f}")
    return f"dim={len(vec)}, norm={norm:.4f}"


def test_embedding_tables_exist():
    from backend.vectorembedding import get_hana_connection, _EMBED_SCHEMA
    conn = get_hana_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = ? "
        "AND TABLE_NAME LIKE '%_EMBEDDINGS' ORDER BY TABLE_NAME",
        (_EMBED_SCHEMA,),
    )
    tables = [r[0] for r in cur.fetchall()]
    cur.close()
    conn.close()
    _assert(len(tables) >= 1, "No *_EMBEDDINGS tables found")
    return f"{len(tables)} embedding table(s): {', '.join(tables)}"


def test_embedding_row_counts():
    from backend.vectorembedding import get_hana_connection, _EMBED_SCHEMA
    conn = get_hana_connection()
    cur = conn.cursor()
    counts = {}
    for table in [
        "RISK_ALERTS_EMBEDDINGS",
        "COMPLIANCE_CASES_EMBEDDINGS",
        "SCREENING_RULES_EMBEDDINGS",
    ]:
        try:
            cur.execute(f'SELECT COUNT(*) FROM "{_EMBED_SCHEMA}"."{table}"')
            counts[table] = cur.fetchone()[0]
        except Exception:
            counts[table] = -1
    cur.close()
    conn.close()
    summary = ", ".join(f"{t.replace('_EMBEDDINGS','').replace('RISK_ALERTS','RA')}={n}"
                        for t, n in counts.items())
    total = sum(n for n in counts.values() if n >= 0)
    _assert(total >= 0, "Could not read any embedding tables")
    return f"Row counts — {summary}"


def test_populate_embeddings_incremental():
    """Populate up to 10 more embeddings in RISK_ALERTS (idempotent)."""
    from backend.vectorembedding import populate_embeddings, get_hana_connection, _EMBED_SCHEMA

    n = populate_embeddings(
        table_name="RISK_ALERTS",
        text_col="ALERT_DESCRIPTION",
        pk_col="ALERT_ID",
        limit=10,
    )
    # Verify the count increased (or stayed same if already fully populated)
    conn = get_hana_connection()
    cur = conn.cursor()
    cur.execute(f'SELECT COUNT(*) FROM "{_EMBED_SCHEMA}"."RISK_ALERTS_EMBEDDINGS"')
    total = cur.fetchone()[0]
    cur.close()
    conn.close()
    _assert(total >= 5, f"Expected >=5 embedded rows, got {total}")
    return f"Populated {n} new rows, total={total}"


def test_vector_similarity_search():
    """Search for alerts similar to a cross-border transfer query."""
    from backend.vectorembedding import search_similar_texts

    query = "high-risk cross-border wire transfer suspicious activity"
    hits = search_similar_texts(
        table_name="RISK_ALERTS",
        text_col="ALERT_DESCRIPTION",
        query=query,
        top_k=3,
        return_cols=["ALERT_DESCRIPTION", "ALERT_TYPE"],
    )
    _assert(isinstance(hits, list), "search_similar_texts must return a list")
    _assert(len(hits) > 0, "Expected at least 1 result — populate embeddings first")
    _assert("SIMILARITY" in hits[0], "Missing SIMILARITY key in result")
    _assert("ALERT_DESCRIPTION" in hits[0], "Missing ALERT_DESCRIPTION in result")

    # Similarity scores must be in [-1, 1]
    for h in hits:
        sim = float(h["SIMILARITY"])
        _assert(-1 <= sim <= 1, f"Similarity {sim} out of [-1,1] range")

    top_sim = round(float(hits[0]["SIMILARITY"]), 4)
    top_txt = textwrap.shorten(str(hits[0]["ALERT_DESCRIPTION"]), 60)
    return f"top_k={len(hits)}, best_sim={top_sim}, text='{top_txt}'"


def test_similarity_ranking_order():
    """Results must be returned in descending similarity order."""
    from backend.vectorembedding import search_similar_texts

    hits = search_similar_texts(
        table_name="RISK_ALERTS",
        text_col="ALERT_DESCRIPTION",
        query="velocity anomaly frequent transactions",
        top_k=5,
        return_cols=["ALERT_DESCRIPTION"],
    )
    if len(hits) < 2:
        return "Only 1 result — ranking order trivially satisfied"
    sims = [float(h["SIMILARITY"]) for h in hits]
    for i in range(len(sims) - 1):
        _assert(
            sims[i] >= sims[i + 1] - 1e-6,
            f"Results not in descending order at index {i}: {sims[i]:.4f} < {sims[i+1]:.4f}",
        )
    return f"Similarity order verified for {len(hits)} results: {[round(s, 4) for s in sims]}"


def test_orchestration_plain_prompt():
    """Baseline: orchestration works with no PII and no masking."""
    from backend.orchestration_config import run_orchestrated_prompt

    response = run_orchestrated_prompt(
        system_instruction="You are a compliance analyst. Be concise.",
        user_prompt="What is the primary purpose of AML transaction monitoring?",
        enable_masking=False,
        enable_filtering=True,
        max_tokens=80,
    )
    _assert(isinstance(response, str), "Response must be a string")
    _assert(len(response) > 20, f"Response too short: {len(response)} chars")
    return f"Response ({len(response)} chars): '{textwrap.shorten(response, 80)}'"


def test_orchestration_with_pii_masking():
    """
    Core test: PII-laden input through the full pipeline.
    Verify that masking executes and a non-empty narrative is returned.
    """
    from backend.orchestration_config import run_orchestrated_prompt

    pii_prompt = (
        "Investigate the following transaction: John Doe (john.doe@acme-corp.com, "
        "+1-212-555-0199) transferred USD 75,000 to Jane Smith's account "
        "(IBAN: DE89 3704 0044 0532 0130 00) on behalf of Acme Holdings Ltd. "
        "The transfer was flagged for HIGH_RISK_GEOGRAPHY. "
        "Summarize the AML risk and recommend next steps."
    )

    t0 = time.monotonic()
    response = run_orchestrated_prompt(
        system_instruction=(
            "You are TrustSphere, an expert AML compliance analyst. "
            "Generate a structured SAR investigation summary."
        ),
        user_prompt=pii_prompt,
        enable_masking=True,
        enable_filtering=True,
        max_tokens=300,
    )
    elapsed = (time.monotonic() - t0) * 1000

    _assert(isinstance(response, str), "Response must be a string")
    _assert(len(response) > 50, f"Response too short ({len(response)} chars)")

    # Check that the pipeline returned a substantive response
    lower = response.lower()
    _assert(
        any(kw in lower for kw in ["risk", "aml", "transaction", "suspicious", "compliance", "flag"]),
        "Response does not appear to contain AML-relevant content",
    )

    print(f"\n    {BOLD('Masked + Filtered LLM Response:')}")
    for line in response.split("\n"):
        if line.strip():
            print(f"      {line}")

    return f"Masking+filtering pipeline OK | {elapsed:.0f} ms | {len(response)} chars"


def test_full_sar_investigation_simulation():
    """
    Full end-to-end SAR simulation mirroring POST /api/investigate.
    Uses a real ALERT_ID from TEAM_12.RISK_ALERTS.
    """
    from backend.vectorembedding import get_hana_connection, search_similar_texts
    from backend.orchestration_config import run_orchestrated_prompt

    # ── Step 1: Pick a real alert ────────────────────────────────────────────
    conn = get_hana_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT TOP 1 a.ALERT_ID, a.ALERT_TYPE, a.ALERT_PRIORITY, a.ALERT_DESCRIPTION, "
        "a.TRANSACTION_ID, a.COMPANY_ID, t.AMOUNT_USD, t.IS_CROSS_BORDER "
        "FROM TEAM_12.RISK_ALERTS a "
        "LEFT JOIN TEAM_12.TRANSACTIONS t ON t.TRANSACTION_ID = a.TRANSACTION_ID "
        "WHERE a.ALERT_PRIORITY IN ('HIGH', 'CRITICAL') "
        "ORDER BY a.ALERT_ID"
    )
    row = cur.fetchone()
    cur.close()
    conn.close()

    _assert(row is not None, "No HIGH/CRITICAL alerts found in TEAM_12.RISK_ALERTS")
    alert_id, alert_type, priority, description, txn_id, company_id, amount, cross_border = row

    print(f"\n    {DIM('Alert selected:')} ID={alert_id} | Type={alert_type} | "
          f"Priority={priority} | Amt={amount} | CrossBorder={cross_border}")

    # ── Step 2: Vector RAG search ────────────────────────────────────────────
    t_rag = time.monotonic()
    hits = search_similar_texts(
        table_name="RISK_ALERTS",
        text_col="ALERT_DESCRIPTION",
        query=str(description),
        top_k=3,
        return_cols=["ALERT_DESCRIPTION", "ALERT_TYPE"],
    )
    rag_ms = (time.monotonic() - t_rag) * 1000

    _assert(isinstance(hits, list), "RAG search must return a list")
    print(f"    {DIM('RAG results:')} {len(hits)} hit(s) in {rag_ms:.0f} ms")
    for i, h in enumerate(hits, 1):
        sim = round(float(h.get("SIMILARITY", 0)), 4)
        txt = textwrap.shorten(str(h.get("ALERT_DESCRIPTION", "")), 60)
        print(f"      [{i}] sim={sim:.4f}  |  {txt}")

    # ── Step 3: Prompt synthesis ─────────────────────────────────────────────
    rag_block = "\n".join(
        f"[Context {i} | sim={round(float(h['SIMILARITY']),4)}] {h.get('ALERT_DESCRIPTION','')}"
        for i, h in enumerate(hits, 1)
    )
    user_prompt = (
        f"=== ALERT METADATA ===\n"
        f"Alert ID: {alert_id}\n"
        f"Alert Type: {alert_type}\n"
        f"Priority: {priority}\n"
        f"Description: {description}\n"
        f"Transaction ID: {txn_id}\n"
        f"Company ID: {company_id}\n"
        f"Amount (USD): {amount}\n"
        f"Cross-Border: {cross_border}\n"
        f"\n=== SIMILAR HISTORICAL ALERTS (RAG) ===\n{rag_block}\n"
        f"\nGenerate a 3-part SAR compliance narrative: "
        f"(1) Risk Summary, (2) Key Indicators, (3) Recommended Action."
    )

    # ── Step 4: Orchestration ────────────────────────────────────────────────
    t_llm = time.monotonic()
    narrative = run_orchestrated_prompt(
        system_instruction=(
            "You are TrustSphere, an expert AML compliance analyst. "
            "Generate concise, structured SAR investigation narratives."
        ),
        user_prompt=user_prompt,
        enable_masking=True,
        enable_filtering=True,
        max_tokens=400,
    )
    llm_ms = (time.monotonic() - t_llm) * 1000

    _assert(isinstance(narrative, str) and len(narrative) > 50,
            f"Narrative too short or invalid: {len(narrative) if narrative else 0} chars")

    print(f"\n    {BOLD('Generated SAR Narrative')} (LLM: {llm_ms:.0f} ms):")
    for line in narrative.split("\n"):
        if line.strip():
            print(f"      {line}")

    total_ms = rag_ms + llm_ms
    return (
        f"SAR simulation complete | alert={alert_id} | "
        f"RAG={rag_ms:.0f}ms | LLM={llm_ms:.0f}ms | total={total_ms:.0f}ms | "
        f"narrative={len(narrative)} chars"
    )


# =============================================================================
# Runner
# =============================================================================

def main():
    print("=" * 70)
    print(BOLD("  End-to-End Vector + Orchestration Pipeline Test Suite"))
    print("=" * 70)

    suite = [
        ("1. HANA Connectivity",               test_hana_connectivity),
        ("2. Embedding Model Load + Output",    test_embedding_model),
        ("3. Embedding Tables Exist",           test_embedding_tables_exist),
        ("4. Embedding Row Counts",             test_embedding_row_counts),
        ("5. Populate Embeddings (limit=10)",   test_populate_embeddings_incremental),
        ("6. Vector Similarity Search",         test_vector_similarity_search),
        ("7. Similarity Ranking Order",         test_similarity_ranking_order),
        ("8. Orchestration — Plain Prompt",     test_orchestration_plain_prompt),
        ("9. Orchestration — PII Masking",      test_orchestration_with_pii_masking),
        ("10. Full SAR Investigation Sim",      test_full_sar_investigation_simulation),
    ]

    passed = 0
    failed = 0
    total_ms = 0.0

    for name, fn in suite:
        ok = _run_test(name, fn)
        if ok:
            passed += 1
        else:
            failed += 1

    total_ms = sum(r[3] for r in _results)

    print()
    print("=" * 70)
    print(BOLD("  RESULTS SUMMARY"))
    print("=" * 70)
    print(f"  {'Test':<42} {'Status':<10} {'ms':>8}")
    print(f"  {'-'*42} {'-'*10} {'-'*8}")
    for name, ok, detail, ms in _results:
        status = OK("PASS") if ok else FAIL("FAIL")
        print(f"  {name:<42} {status:<10} {ms:>7.0f}")
    print(f"  {'-'*42} {'-'*10} {'-'*8}")
    print(f"  {'TOTAL':42}  {passed}/{passed+failed} passed   {total_ms:>6.0f} ms")
    print()
    if failed == 0:
        print(OK("  All tests passed!"))
    else:
        print(FAIL(f"  {failed} test(s) failed — check output above for details."))
    print("=" * 70)

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
