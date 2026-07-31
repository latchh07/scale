"""
backend/main.py
===============
FastAPI service exposing the RAG + Orchestration pipeline for SAR/AML workflows.

Endpoints
---------
GET  /health                        — liveness check
POST /api/investigate               — full RAG → Orchestration → narrative
POST /api/cases/{case_id}/narrative — case-scoped compliance narrative
POST /api/alerts/similar            — raw vector similarity search (no LLM)

Architecture per request (investigate / narrative)
--------------------------------------------------
  1. SQL  — fetch alert + transaction metadata from TEAM_12
  2. RAG  — vector search in TEAM_12_USER.*_EMBEDDINGS via search_similar_texts()
  3. Synthesis — merge SQL row data with retrieved snippets into augmented prompt
  4. Orchestration — PII masking → Azure content filter → gpt-4o → output filter
  5. Response — structured JSON with narrative + citation source IDs

Run:
  uvicorn backend.main:app --reload --port 8000
"""

from __future__ import annotations

import os
import sys
import json

import time
from contextlib import asynccontextmanager
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from typing import List, Optional

# Force UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

_ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "team_12.env")
load_dotenv(dotenv_path=_ENV_PATH)

_HANA_SCHEMA  = os.getenv("HANA_SCHEMA", "TEAM_12")
_EMBED_SCHEMA = os.getenv("HANA_USER", "TEAM_12_USER")


# ---------------------------------------------------------------------------
# Lifespan: warm up sentence-transformers model at startup
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Warm up the embedding model so first request isn't slow."""
    from backend.vectorembedding import _load_embed_model
    print("[startup] Loading sentence-transformers model...")
    _load_embed_model()
    print("[startup] Model ready.")
    yield
    print("[shutdown] Goodbye.")


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="TrustSphere AI — Compliance Intelligence API",
    description=(
        "RAG-powered compliance narrative generation and SAR investigation "
        "assistance using SAP HANA Cloud vector search + SAP AI Core (gpt-4o)."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Pydantic request / response models
# ---------------------------------------------------------------------------

class InvestigateRequest(BaseModel):
    alert_id: int = Field(..., description="ALERT_ID from TEAM_12.RISK_ALERTS")
    query_context: Optional[str] = Field(
        None,
        description="Optional investigator note / query to guide the narrative",
    )
    top_k: int = Field(3, ge=1, le=10, description="Similar alerts to retrieve")
    enable_masking: bool = Field(True, description="Toggle SAP DPI pseudonymization")
    enable_filtering: bool = Field(True, description="Toggle Azure Content Safety")


class NarrativeRequest(BaseModel):
    free_text_query: str = Field(
        ..., description="Investigator query describing the scenario"
    )
    top_k: int = Field(3, ge=1, le=10)
    enable_masking: bool = Field(True)
    enable_filtering: bool = Field(True)


class SimilarAlertsRequest(BaseModel):
    query: str = Field(..., description="Free-text query to match against alert embeddings")
    top_k: int = Field(5, ge=1, le=20)


class JouleRequest(BaseModel):
    query: str
    alert_id: Optional[str] = None
    case_id: Optional[str] = None
    context: Optional[dict] = None


class RiskFactor(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    score: float = Field(ge=0, le=100)
    weight: float = Field(ge=0, le=1)
    rationale: str

class AnalysisSection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1)
    content: str = Field(min_length=1)

class AnalysisResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1)
    sections: List[AnalysisSection] = Field(min_length=1)
    recommendation: str = Field(min_length=1)
    risk_factors: List[RiskFactor] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _get_conn():
    from backend.vectorembedding import get_hana_connection
    return get_hana_connection()


def _fetch_alert_metadata(alert_id: int) -> dict:
    """Pull alert + linked transaction data from TEAM_12."""
    conn = _get_conn()
    cur = conn.cursor()
    try:
        cur.execute(
            f"""
            SELECT
                a.ALERT_ID, a.ALERT_UUID, a.ALERT_TYPE, a.ALERT_SUBTYPE,
                a.ALERT_PRIORITY, a.ALERT_TITLE, a.ALERT_DESCRIPTION,
                a.RISK_DRIVERS, a.RECOMMENDED_ACTIONS, a.STATUS,
                a.COMPANY_ID, a.TRANSACTION_ID,
                t.AMOUNT_USD, t.CURRENCY_ORIGINAL, t.TRANSACTION_TYPE,
                t.IS_CROSS_BORDER, t.BENEFICIARY_COUNTRY_ID,
                t.PAYMENT_PURPOSE, t.INITIATED_AT
            FROM "{_HANA_SCHEMA}"."RISK_ALERTS" a
            LEFT JOIN "{_HANA_SCHEMA}"."TRANSACTIONS" t
                ON t.TRANSACTION_ID = a.TRANSACTION_ID
            WHERE a.ALERT_ID = ?
            """,
            (alert_id,),
        )
        row = cur.fetchone()
        if not row:
            return {}
        cols = [d[0] for d in cur.description]
        return dict(zip(cols, (str(v) if v is not None else None for v in row)))
    finally:
        cur.close()
        conn.close()


def _build_rag_context(hits: list[dict], text_col: str) -> str:
    """Format retrieved vector search hits into a numbered context block."""
    lines = []
    for i, h in enumerate(hits, 1):
        sim = round(float(h.get("SIMILARITY", 0)), 4)
        text = str(h.get(text_col, "")).strip()
        lines.append(f"[Context {i} | similarity={sim}] {text}")
    return "\n".join(lines)


def _build_system_prompt() -> str:
    return (
        "You are TrustSphere, an expert AML (Anti-Money Laundering) compliance analyst. "
        "Your task is to generate a clear, concise compliance narrative for a Suspicious "
        "Activity Report (SAR) investigation. "
        "Use the transaction metadata and retrieved similar alert contexts provided. "
        "You MUST output valid JSON exactly matching this schema:\n"
        '{\n'
        '  "title": "<String>",\n'
        '  "sections": [\n'
        '    { "label": "<String>", "content": "<String>" }\n'
        '  ],\n'
        '  "recommendation": "<String>",\n'
        '  "risk_factors": [\n'
        '    { "name": "<String>", "score": <Float 0-100>, "weight": <Float 0-1>, "rationale": "<String>" }\n'
        '  ]\n'
        '}\n'
        "Do not include any markdown fences or extra text."
    )


def _build_user_prompt(metadata: dict, rag_context: str, extra_query: str = "") -> str:
    parts = ["=== TRANSACTION & ALERT METADATA ==="]
    for k, v in metadata.items():
        if v and v != "None":
            parts.append(f"{k}: {v}")

    if rag_context:
        parts.append("\n=== SIMILAR HISTORICAL ALERTS (RAG Context) ===")
        parts.append(rag_context)

    if extra_query:
        parts.append(f"\n=== INVESTIGATOR NOTE ===\n{extra_query}")

    parts.append(
        "\nPlease generate a compliance narrative for this alert following the "
        "required JSON structure exactly."
    )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health", tags=["System"])
async def health():
    """Liveness probe — confirms service, HANA connectivity, and model status."""
    from backend.vectorembedding import get_hana_connection, _embed_model
    try:
        conn = get_hana_connection()
        cur = conn.cursor()
        cur.execute(f"SELECT COUNT(*) FROM SYS.TABLES WHERE SCHEMA_NAME = '{_HANA_SCHEMA}'")
        table_count = cur.fetchone()[0]
        cur.close()
        conn.close()
        hana_ok = True
    except Exception as e:
        hana_ok = False
        table_count = -1

    return {
        "status": "ready" if hana_ok else "degraded",
        "hana_connected": hana_ok,
        "hana_schema": _HANA_SCHEMA,
        "embed_schema": _EMBED_SCHEMA,
        "hana_table_count": table_count,
        "embedding_model_loaded": _embed_model is not None,
        "version": "1.0.0",
    }


@app.post("/api/investigate", response_model=AnalysisResponse, tags=["Investigation"])
async def investigate(req: InvestigateRequest):
    """
    Full RAG + Orchestration pipeline for a specific alert.

    Steps:
      A) Fetch alert + transaction metadata via SQL
      B) Vector search: retrieve top-k similar alert descriptions
      C) Synthesize augmented prompt from metadata + RAG context
      D) Run through SAP AI Core orchestration (masking + filtering + gpt-4o)
      E) Return structured JSON with narrative and citation sources
    """
    t_start = time.monotonic()

    from backend.vectorembedding import search_similar_texts, populate_embeddings
    from backend.orchestration_config import run_orchestrated_prompt

    # ── A. Fetch alert metadata ──────────────────────────────────────────────
    metadata = _fetch_alert_metadata(req.alert_id)
    if not metadata:
        raise HTTPException(
            status_code=404,
            detail=f"Alert ID {req.alert_id} not found in {_HANA_SCHEMA}.RISK_ALERTS",
        )

    # ── B. RAG — vector similarity search ───────────────────────────────────
    query_text = (
        req.query_context
        or metadata.get("ALERT_DESCRIPTION")
        or metadata.get("ALERT_TYPE", "AML investigation")
    )

    hits = search_similar_texts(
        table_name="RISK_ALERTS",
        text_col="ALERT_DESCRIPTION",
        query=query_text,
        top_k=req.top_k,
        return_cols=["ALERT_DESCRIPTION", "ALERT_TYPE", "ALERT_PRIORITY"],
    )

    # ── C. Prompt synthesis ──────────────────────────────────────────────────
    rag_context = _build_rag_context(hits, "ALERT_DESCRIPTION")
    system_prompt = _build_system_prompt()
    user_prompt = _build_user_prompt(metadata, rag_context, req.query_context or "")

    # ── D. Orchestration ─────────────────────────────────────────────────────
    try:
        narrative = run_orchestrated_prompt(
            system_instruction=system_prompt,
            user_prompt=user_prompt,
            enable_masking=req.enable_masking,
            enable_filtering=req.enable_filtering,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # ── E. Parse response ────────────────────────────────────────────────────
    from backend.joule_agent import _extract_and_repair_json
    
    result = _extract_and_repair_json(narrative)
    
    # Strip any extra keys to ensure strict validation
    valid_keys = {"title", "sections", "recommendation", "risk_factors"}
    stripped_result = {k: v for k, v in result.items() if k in valid_keys}
    
    return stripped_result


@app.post(
    "/api/cases/{case_id}/narrative",
    tags=["Investigation"],
    summary="Generate compliance narrative for a compliance case",
)
async def case_narrative(case_id: int, req: NarrativeRequest):
    """
    Case-scoped RAG + narrative generation routed via Joule Agent.
    """
    from backend.joule_agent import process_joule_query
    
    try:
        # Route to Joule orchestrator
        result = process_joule_query(
            req.free_text_query, 
            {"case_id": str(case_id)}
        )
        return {
            "case_id": case_id,
            "narrative": json.dumps(result),  # stringified Joule JSON
            "model": "gpt-4o"
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/alerts/similar", tags=["Search"])
async def similar_alerts(req: SimilarAlertsRequest):
    """
    Raw vector similarity search against RISK_ALERTS_EMBEDDINGS.
    Returns top-k most semantically similar alert descriptions (no LLM).
    """
    from backend.vectorembedding import search_similar_texts

    hits = search_similar_texts(
        table_name="RISK_ALERTS",
        text_col="ALERT_DESCRIPTION",
        query=req.query,
        top_k=req.top_k,
        return_cols=["ALERT_DESCRIPTION", "ALERT_TYPE", "ALERT_PRIORITY"],
    )

    return {
        "query": req.query,
        "results": [
            {
                "source_id":   int(h.get("SOURCE_ID", 0)),
                "similarity":  round(float(h.get("SIMILARITY", 0)), 4),
                "alert_type":  h.get("ALERT_TYPE"),
                "priority":    h.get("ALERT_PRIORITY"),
                "description": str(h.get("ALERT_DESCRIPTION", ""))[:300],
            }
            for h in hits
        ],
        "total": len(hits),
    }


@app.post("/api/joule/chat", response_model=AnalysisResponse, tags=["Agent"])
async def joule_chat(req: JouleRequest):
    """
    Joule Agent Orchestrator.
    Routes queries to 5 distinct AML skills and returns a strict JSON UI schema.
    """
    from backend.joule_agent import process_joule_query
    
    ctx = req.context or {}
    if req.alert_id:
        ctx["alert_id"] = req.alert_id
    if req.case_id:
        ctx["case_id"] = req.case_id

    try:
        result = process_joule_query(req.query, ctx)
        # Strip _meta and strictly format output
        valid_keys = {"title", "sections", "recommendation", "risk_factors"}
        stripped_result = {k: v for k, v in result.items() if k in valid_keys}
        return stripped_result
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

