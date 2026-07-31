"""
backend/vectorembedding.py
==========================
Vector embedding operations for SAP HANA Cloud (TEAM_12 schema).

Architecture
------------
* HANA Cloud:  read from TEAM_12.* tables (read-only for TEAM_12_USER)
               write embedding tables to TEAM_12_USER schema (CREATE rights confirmed)
* Embeddings:  sentence-transformers all-MiniLM-L6-v2 (384-dim, local)
               — easily swappable for a hosted embedding model
* LLM calls:   SAP AI Core orchestration service (gpt-4o, working)

Embedding tables schema (stored in TEAM_12_USER):
    <TABLE>_EMBEDDINGS (
        SOURCE_ID        INTEGER       NOT NULL,
        SOURCE_COLUMN    NVARCHAR(128) NOT NULL,
        EMBEDDING_VECTOR REAL_VECTOR(384),
        PRIMARY KEY (SOURCE_ID, SOURCE_COLUMN)
    )

Public API
----------
  get_hana_connection()       -> hdbcli Connection
  get_embedding(text)         -> list[float]  (384-dim)
  setup_embedding_tables()    -> creates *_EMBEDDINGS tables if absent
  populate_embeddings(...)    -> fills embedding rows from NCLOB source
  search_similar_texts(...)   -> cosine similarity ANN search, returns top-k hits
  llm_completion(prompt)      -> str  (SAP AI Core gpt-4o response)

Run directly for a smoke test:
  python backend/vectorembedding.py
"""

from __future__ import annotations

import os
import sys
import json
import textwrap
from typing import Optional

from dotenv import load_dotenv
from hdbcli import dbapi

# Force UTF-8 console output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# 1.  Environment & credentials
# ---------------------------------------------------------------------------

_ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "team_12.env")
load_dotenv(dotenv_path=_ENV_PATH)

_HANA_ADDRESS  = os.getenv("HANA_ADDRESS") or os.getenv("HANA_HOST")
_HANA_PORT     = int(os.getenv("HANA_PORT", 443))
_HANA_USER     = os.getenv("HANA_USER")       # TEAM_12_USER
_HANA_PASSWORD = os.getenv("HANA_PASSWORD")
_HANA_SCHEMA   = os.getenv("HANA_SCHEMA", "TEAM_12")       # read-only source
_EMBED_SCHEMA  = _HANA_USER                                 # TEAM_12_USER — writable

_AICORE_CLIENT_ID      = os.getenv("AICORE_CLIENT_ID")
_AICORE_CLIENT_SECRET  = os.getenv("AICORE_CLIENT_SECRET")
_AICORE_AUTH_URL       = os.getenv("AICORE_AUTH_URL", "")
_AICORE_API_URL        = os.getenv("AICORE_API_URL", "")
_AICORE_RESOURCE_GROUP = os.getenv("AICORE_RESOURCE_GROUP", "team-12")

# Orchestration deployment (SAP AI Core, confirmed working)
_ORCH_DEPLOY_URL = (
    "https://api.ai.prod-ap11.ap-southeast-1.aws.ml.hana.ondemand.com"
    "/v2/inference/deployments/d6405ae8bcff77e3"
)

# Local embedding model (sentence-transformers)
# all-MiniLM-L6-v2: 384-dim, fast, good quality for semantic search
_EMBED_MODEL_NAME = "all-MiniLM-L6-v2"
EMBEDDING_DIM = 384

# NCLOB source columns per table: {table: (pk_col, [text_cols])}
EMBEDDABLE_COLUMNS: dict[str, tuple[str, list[str]]] = {
    "RISK_ALERTS":             ("ALERT_ID",      ["ALERT_DESCRIPTION", "RECOMMENDED_ACTIONS", "RISK_DRIVERS"]),
    "COMPLIANCE_CASES":        ("CASE_ID",        ["CASE_SUMMARY"]),
    "JOULE_EXPLANATIONS":      ("EXPLANATION_ID", ["EXPLANATION_TEXT", "INPUT_CONTEXT"]),
    "SCREENING_RULES":         ("RULE_ID",        ["RULE_DESCRIPTION"]),
    "TRANSACTION_RISK_SCORES": ("SCORE_ID",       ["ANOMALY_DETAILS"]),
    "AUDIT_LOG":               ("LOG_ID",         ["CHANGE_SUMMARY"]),
}

# Lazy-loaded embedding model singleton
_embed_model = None


# ---------------------------------------------------------------------------
# 2.  Database connection helper
# ---------------------------------------------------------------------------

def get_hana_connection() -> dbapi.Connection:
    """Return a live hdbcli connection to SAP HANA Cloud."""
    return dbapi.connect(
        address=_HANA_ADDRESS,
        port=_HANA_PORT,
        user=_HANA_USER,
        password=_HANA_PASSWORD,
        encrypt=True,
        sslValidateCertificate=False,
        sslHostNameInCertificate="*",
    )


# ---------------------------------------------------------------------------
# 3.  Embedding helper  (sentence-transformers, local)
# ---------------------------------------------------------------------------

def _load_embed_model():
    """Lazy-load the sentence-transformers model (cached after first call)."""
    global _embed_model
    if _embed_model is None:
        from sentence_transformers import SentenceTransformer
        print(f"  [embed] Loading model '{_EMBED_MODEL_NAME}' ...")
        _embed_model = SentenceTransformer(_EMBED_MODEL_NAME)
        print(f"  [embed] Model ready  (dim={EMBEDDING_DIM})")
    return _embed_model


def get_embedding(text: str) -> list[float]:
    """
    Generate a {EMBEDDING_DIM}-dimensional embedding vector for *text*
    using sentence-transformers all-MiniLM-L6-v2 (local inference).

    Returns a list[float] of length EMBEDDING_DIM.
    """
    model = _load_embed_model()
    vector = model.encode(text, normalize_embeddings=True)
    return vector.tolist()


# ---------------------------------------------------------------------------
# 4.  LLM helper  (SAP AI Core orchestration — gpt-4o)
# ---------------------------------------------------------------------------

def llm_completion(
    prompt: str,
    system_prompt: str = "You are a helpful financial compliance assistant.",
    model: str = "gpt-4o",
    max_tokens: int = 512,
) -> str:
    """
    Call SAP AI Core orchestration service for an LLM completion.

    Parameters
    ----------
    prompt      : User message
    system_prompt: System context
    model       : LLM model name (must be supported by the orchestration endpoint)
    max_tokens  : Maximum tokens in response

    Returns
    -------
    The assistant's response string.
    """
    from gen_ai_hub.orchestration.service import OrchestrationService
    from gen_ai_hub.orchestration.models.config import OrchestrationConfig
    from gen_ai_hub.orchestration.models.llm import LLM
    from gen_ai_hub.orchestration.models.message import SystemMessage, UserMessage
    from gen_ai_hub.orchestration.models.template import Template
    from gen_ai_hub.proxy.core.proxy_clients import get_proxy_client

    proxy = get_proxy_client(
        proxy_client_name="gen-ai-hub",
        base_url=_AICORE_API_URL,
        auth_url=_AICORE_AUTH_URL.rstrip("/") + "/oauth/token",
        client_id=_AICORE_CLIENT_ID,
        client_secret=_AICORE_CLIENT_SECRET,
        resource_group=_AICORE_RESOURCE_GROUP,
    )

    llm_cfg = LLM(name=model, parameters={"max_tokens": max_tokens})
    template = Template(messages=[
        SystemMessage(system_prompt),
        UserMessage(prompt),
    ])
    config = OrchestrationConfig(llm=llm_cfg, template=template)
    svc = OrchestrationService(api_url=_ORCH_DEPLOY_URL, config=config, proxy_client=proxy)
    result = svc.run()
    return result.orchestration_result.choices[0].message.content


# ---------------------------------------------------------------------------
# 5.  Schema setup — create *_EMBEDDINGS tables in TEAM_12_USER schema
# ---------------------------------------------------------------------------

def setup_embedding_tables(conn: Optional[dbapi.Connection] = None) -> dict[str, bool]:
    """
    For each table in EMBEDDABLE_COLUMNS, create a companion
    TEAM_12_USER.<TABLE>_EMBEDDINGS COLUMN TABLE if it does not yet exist.

    Returns a dict mapping embedding_table_name -> True if created, False if existed.
    """
    _own_conn = conn is None
    if _own_conn:
        conn = get_hana_connection()

    cursor = conn.cursor()
    status: dict[str, bool] = {}

    print(f"\n[setup_embedding_tables]")
    print(f"  Source schema  : {_HANA_SCHEMA}  (read-only)")
    print(f"  Embedding schema: {_EMBED_SCHEMA}  (writable)")
    print("-" * 60)

    for source_table in EMBEDDABLE_COLUMNS:
        embed_table = f"{source_table}_EMBEDDINGS"
        full_embed  = f'"{_EMBED_SCHEMA}"."{embed_table}"'

        cursor.execute(
            "SELECT COUNT(*) FROM SYS.TABLES "
            "WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?",
            (_EMBED_SCHEMA, embed_table),
        )
        exists = cursor.fetchone()[0] > 0

        if exists:
            print(f"  [SKIP]    {_EMBED_SCHEMA}.{embed_table}  (already exists)")
            status[embed_table] = False
        else:
            try:
                cursor.execute(
                    f"CREATE COLUMN TABLE {full_embed} ("
                    f'  SOURCE_ID        INTEGER       NOT NULL, '
                    f'  SOURCE_COLUMN    NVARCHAR(128) NOT NULL, '
                    f'  EMBEDDING_VECTOR REAL_VECTOR({EMBEDDING_DIM}), '
                    f'  PRIMARY KEY (SOURCE_ID, SOURCE_COLUMN)'
                    f")"
                )
                conn.commit()
                print(f"  [CREATED] {_EMBED_SCHEMA}.{embed_table}  REAL_VECTOR({EMBEDDING_DIM})")
                status[embed_table] = True
            except Exception as exc:
                print(f"  [ERROR]   {embed_table}: {exc}")
                status[embed_table] = False

    if _own_conn:
        cursor.close()
        conn.close()

    return status


# ---------------------------------------------------------------------------
# 6.  Populate embeddings
# ---------------------------------------------------------------------------

def populate_embeddings(
    table_name: str,
    text_col: str,
    pk_col: str,
    batch_size: int = 50,
    limit: Optional[int] = None,
    conn: Optional[dbapi.Connection] = None,
) -> int:
    """
    Fetch rows from TEAM_12.*table_name* where no embedding exists yet
    in TEAM_12_USER.<table_name>_EMBEDDINGS, generate embeddings, and INSERT.

    Parameters
    ----------
    table_name : Source table in _HANA_SCHEMA
    text_col   : NCLOB column to embed
    pk_col     : Primary key column name
    batch_size : Rows per commit cycle
    limit      : Cap total rows (useful for testing)
    conn       : Optional existing connection

    Returns
    -------
    Number of rows successfully embedded.
    """
    _own_conn = conn is None
    if _own_conn:
        conn = get_hana_connection()

    cursor = conn.cursor()
    embed_table = f"{table_name}_EMBEDDINGS"
    full_source = f'"{_HANA_SCHEMA}"."{table_name}"'
    full_embed  = f'"{_EMBED_SCHEMA}"."{embed_table}"'
    limit_clause = f"LIMIT {limit}" if limit else ""

    cursor.execute(
        f'SELECT src."{pk_col}", src."{text_col}" '
        f"FROM {full_source} src "
        f'WHERE src."{text_col}" IS NOT NULL '
        f"  AND NOT EXISTS ("
        f"      SELECT 1 FROM {full_embed} emb "
        f"      WHERE emb.SOURCE_ID = src.\"{pk_col}\" "
        f"        AND emb.SOURCE_COLUMN = ?"
        f"  ) "
        f"{limit_clause}",
        (text_col,),
    )
    rows = cursor.fetchall()
    total = len(rows)
    embedded = 0

    print(f"\n[populate_embeddings] {table_name}.{text_col}  -> {total} rows to embed")
    if total == 0:
        if _own_conn:
            cursor.close()
            conn.close()
        return 0

    # Pre-load the model before the loop
    _load_embed_model()

    for pk_val, text_val in rows:
        try:
            text_str = (text_val if isinstance(text_val, str) else str(text_val))[:8000]
            vector = get_embedding(text_str)
            vector_str = json.dumps(vector)

            cursor.execute(
                f"INSERT INTO {full_embed} (SOURCE_ID, SOURCE_COLUMN, EMBEDDING_VECTOR) "
                f"VALUES (?, ?, TO_REAL_VECTOR(?))",
                (pk_val, text_col, vector_str),
            )
            embedded += 1

            if embedded % batch_size == 0:
                conn.commit()
                print(f"  ... committed {embedded}/{total}")

        except Exception as exc:
            print(f"  [WARN] Row pk={pk_val} skipped: {exc}")

    conn.commit()
    print(f"  Done -- embedded {embedded}/{total} rows.")

    if _own_conn:
        cursor.close()
        conn.close()

    return embedded


# ---------------------------------------------------------------------------
# 7.  Cosine similarity search
# ---------------------------------------------------------------------------

def search_similar_texts(
    table_name: str,
    text_col: str,
    query: str,
    top_k: int = 3,
    return_cols: Optional[list[str]] = None,
    conn: Optional[dbapi.Connection] = None,
) -> list[dict]:
    """
    Find the top-k rows whose embedding (in TEAM_12_USER.<TABLE>_EMBEDDINGS)
    is most similar to the embedding of *query* (cosine similarity).

    Parameters
    ----------
    table_name  : Source HANA table name (in TEAM_12 schema)
    text_col    : NCLOB column whose embeddings to search
    query       : Free-text query string
    top_k       : Number of results
    return_cols : Additional columns from source table in results
    conn        : Optional existing connection

    Returns
    -------
    List of dicts with keys: SIMILARITY, SOURCE_ID, and any return_cols.
    """
    _own_conn = conn is None
    if _own_conn:
        conn = get_hana_connection()

    cursor = conn.cursor()
    embed_table = f"{table_name}_EMBEDDINGS"
    pk_col      = _get_pk_col(table_name)
    full_source = f'"{_HANA_SCHEMA}"."{table_name}"'
    full_embed  = f'"{_EMBED_SCHEMA}"."{embed_table}"'

    if return_cols is None:
        return_cols = [text_col]

    extra_select = ", ".join(f'src."{c}"' for c in return_cols)

    # Embed the query
    query_vector = get_embedding(query)
    query_vector_str = json.dumps(query_vector)

    sql = (
        f"SELECT TOP {top_k} "
        f"  COSINE_SIMILARITY(emb.EMBEDDING_VECTOR, TO_REAL_VECTOR(?)) AS SIMILARITY, "
        f"  emb.SOURCE_ID, "
        f"  {extra_select} "
        f"FROM {full_embed} emb "
        f'JOIN {full_source} src ON src."{pk_col}" = emb.SOURCE_ID '
        f"WHERE emb.SOURCE_COLUMN = ? "
        f"  AND emb.EMBEDDING_VECTOR IS NOT NULL "
        f"ORDER BY SIMILARITY DESC"
    )

    cursor.execute(sql, (query_vector_str, text_col))
    rows = cursor.fetchall()
    col_names = [desc[0] for desc in cursor.description]
    results = [dict(zip(col_names, row)) for row in rows]

    if _own_conn:
        cursor.close()
        conn.close()

    return results


def _get_pk_col(table_name: str) -> str:
    entry = EMBEDDABLE_COLUMNS.get(table_name)
    if entry:
        return entry[0]
    raise ValueError(f"Table '{table_name}' not registered in EMBEDDABLE_COLUMNS.")


# ---------------------------------------------------------------------------
# 8.  Main -- smoke test
# ---------------------------------------------------------------------------

def _banner(label: str = ""):
    print("=" * 65)
    if label:
        print(f"  {label}")
        print("=" * 65)


if __name__ == "__main__":
    _banner("backend/vectorembedding.py  --  Smoke Test")

    # A. HANA connectivity
    print("\n[1] HANA connection ...")
    try:
        conn = get_hana_connection()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM SYS.TABLES WHERE SCHEMA_NAME = ?", (_HANA_SCHEMA,))
        n = cur.fetchone()[0]
        cur.close()
        conn.close()
        print(f"  Connected  -> {_HANA_ADDRESS}")
        print(f"  Schema '{_HANA_SCHEMA}' has {n} table(s).  [OK]")
    except Exception as exc:
        print(f"  [FAIL] {exc}")
        sys.exit(1)

    # B. Create embedding tables in TEAM_12_USER schema
    print("\n[2] Setting up *_EMBEDDINGS COLUMN tables in '{_EMBED_SCHEMA}' ...")
    created = setup_embedding_tables()
    n_created = sum(1 for v in created.values() if v)
    n_skipped = sum(1 for v in created.values() if not v)
    print(f"\n  Created: {n_created}  |  Skipped (already exist): {n_skipped}")

    # Verify
    conn = get_hana_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT TABLE_NAME FROM SYS.TABLES "
        "WHERE SCHEMA_NAME = ? AND TABLE_NAME LIKE '%_EMBEDDINGS' "
        "ORDER BY TABLE_NAME",
        (_EMBED_SCHEMA,),
    )
    embed_tables = [r[0] for r in cur.fetchall()]
    cur.close()
    conn.close()
    print(f"  Embedding tables in DB: {embed_tables}  [OK]")

    # C. Embedding model test (local)
    print("\n[3] Embedding model test (sentence-transformers) ...")
    test_text = "Suspicious high-value cross-border transaction flagged for AML review."
    vec = get_embedding(test_text)
    assert len(vec) == EMBEDDING_DIM, f"Expected {EMBEDDING_DIM}, got {len(vec)}"
    print(f"  Input   : {test_text!r}")
    print(f"  Dim     : {len(vec)}  [OK]")
    print(f"  First 5 : {[round(v, 6) for v in vec[:5]]}")

    # D. Populate a small sample (limit=5 for smoke test)
    print("\n[4] Populating embeddings: RISK_ALERTS.ALERT_DESCRIPTION (limit=5) ...")
    n_embedded = populate_embeddings(
        table_name="RISK_ALERTS",
        text_col="ALERT_DESCRIPTION",
        pk_col="ALERT_ID",
        limit=5,
    )
    print(f"  Rows embedded this run: {n_embedded}")

    # E. Similarity search
    print("\n[5] Cosine similarity search: RISK_ALERTS.ALERT_DESCRIPTION ...")
    hits = search_similar_texts(
        table_name="RISK_ALERTS",
        text_col="ALERT_DESCRIPTION",
        query="unusual cross-border wire transfer",
        top_k=3,
        return_cols=["ALERT_DESCRIPTION"],
    )
    if hits:
        print(f"\n  Top {len(hits)} result(s):")
        for i, h in enumerate(hits, 1):
            sim  = round(float(h.get("SIMILARITY", 0)), 4)
            text = textwrap.shorten(str(h.get("ALERT_DESCRIPTION", "")), 100)
            print(f"  [{i}] sim={sim:6.4f}  |  {text}")
    else:
        print("  No results returned.")

    # F. LLM test (SAP AI Core orchestration)
    print("\n[6] LLM test (SAP AI Core / gpt-4o) ...")
    try:
        response = llm_completion(
            prompt="In one sentence, what is AML compliance?",
            max_tokens=60,
        )
        print(f"  Response: {response}")
        print("  LLM [OK]")
    except Exception as exc:
        print(f"  [SKIP] LLM test: {exc}")

    _banner()
    print("  Smoke test complete.")
    _banner()
