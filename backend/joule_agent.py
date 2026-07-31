"""
backend/joule_agent.py
======================
Compliance & AML Custom Joule Agent

5 Distinct Modular Skill Tools:
  1. get_triage_queue_skill
  2. explain_risk_score_skill
  3. run_screening_check_skill
  4. assemble_and_draft_case_skill
  5. check_aging_escalations_skill

Orchestration:
  - Routes incoming user_query to the appropriate skill
  - Executes skill to gather facts from SAP HANA Cloud / Vector DB
  - Synthesizes using run_orchestrated_prompt (GPT-4o + Masking + Filtering)
  - Enforces strict JSON output schema

Output Schema:
  {
    "title": "String",
    "sections": [
      { "label": "String", "content": "String" }
    ],
    "recommendation": "String"
  }
"""

from __future__ import annotations

import os
import re
import sys
import json
import textwrap
from difflib import SequenceMatcher
from typing import Optional, Any
from datetime import datetime

from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "team_12.env")
load_dotenv(dotenv_path=_ENV_PATH)

_HANA_SCHEMA  = os.getenv("HANA_SCHEMA", "TEAM_12")
_EMBED_SCHEMA = os.getenv("HANA_USER",   "TEAM_12_USER")

# ---------------------------------------------------------------------------
# Database Helper
# ---------------------------------------------------------------------------
def _get_conn():
    from backend.vectorembedding import get_hana_connection
    return get_hana_connection()

# ---------------------------------------------------------------------------
# Skill 1: Triage Queue
# ---------------------------------------------------------------------------
def get_triage_queue_skill(assessment_id: str = None) -> dict:
    """Queries TRANSACTION_RISK_SCORES and COMPLIANCE_CASES to fetch ranked queues."""
    conn = _get_conn()
    cur = conn.cursor()
    try:
        tx_query = f"""
            SELECT TOP 5 TRANSACTION_ID, ASSESSMENT_ID AS SCORE_ID, OVERALL_SCORE AS OVERALL_RISK_SCORE, 
                   RISK_LEVEL AS RISK_TIER, MODEL_SIGNALS_JSON AS ANOMALY_TYPE, GENERATED_AT AS SCORED_AT
            FROM "{_EMBED_SCHEMA}"."RISK_ASSESSMENTS"
            WHERE OVERALL_SCORE IS NOT NULL
        """
        tx_params = ()
        if assessment_id:
            tx_query += " AND ASSESSMENT_ID = ?"
            tx_params = (assessment_id,)
        tx_query += " ORDER BY OVERALL_SCORE DESC, GENERATED_AT DESC"
        
        cur.execute(tx_query, tx_params)
        tx_rows = cur.fetchall()
        tx_cols = [d[0] for d in cur.description]
        tx_queue = [dict(zip(tx_cols, [str(v) if v is not None else None for v in r])) for r in tx_rows]

        cur.execute(
            f"""
            SELECT TOP 5 CASE_ID, CASE_NUMBER, CASE_PRIORITY, TOTAL_FLAGGED_AMOUNT, STATUS
            FROM "{_HANA_SCHEMA}"."COMPLIANCE_CASES"
            WHERE STATUS != 'CLOSED'
            ORDER BY
                CASE UPPER(CASE_PRIORITY)
                    WHEN 'CRITICAL' THEN 4
                    WHEN 'HIGH' THEN 3
                    WHEN 'MEDIUM' THEN 2
                    WHEN 'LOW' THEN 1
                    ELSE 0
                END DESC,
                TOTAL_FLAGGED_AMOUNT DESC
            """
        )
        case_rows = cur.fetchall()
        case_cols = [d[0] for d in cur.description]
        case_queue = [dict(zip(case_cols, [str(v) if v is not None else None for v in r])) for r in case_rows]

        return {
            "skill": "get_triage_queue_skill",
            "top_risk_transactions": tx_queue,
            "top_priority_cases": case_queue
        }
    finally:
        cur.close()
        conn.close()

# ---------------------------------------------------------------------------
# Skill 2: Explain Risk Score
# ---------------------------------------------------------------------------
def explain_risk_score_skill(alert_id: str = None, assessment_id: str = None, transaction_id: str = None) -> dict:
    """Evaluates sub-scores and pulls vector context via vectorembedding.py."""
    conn = _get_conn()
    cur = conn.cursor()
    try:
        where_clause = ""
        params = []
        if assessment_id:
            where_clause = "WHERE t.ASSESSMENT_ID = ?"
            params.append(assessment_id)
        elif alert_id:
            where_clause = "WHERE a.ALERT_ID = ?"
            params.append(alert_id)
        elif transaction_id:
            where_clause = "WHERE a.TRANSACTION_ID = ?"
            params.append(transaction_id)
            
        cur.execute(
            f"""
            SELECT TOP 1 a.ALERT_ID, a.ALERT_TYPE, a.ALERT_PRIORITY, a.ALERT_DESCRIPTION,
                   a.TRANSACTION_ID, t.ASSESSMENT_ID AS SCORE_ID,
                   t.AMOUNT_RISK_SCORE, t.FREQUENCY_RISK_SCORE, t.GEOGRAPHY_RISK_SCORE,
                   t.COUNTERPARTY_RISK_SCORE, t.PATTERN_RISK_SCORE, t.VELOCITY_RISK_SCORE,
                   t.OVERALL_SCORE AS OVERALL_RISK_SCORE, t.RISK_LEVEL AS RISK_TIER, 
                   t.MODEL_SIGNALS_JSON AS ANOMALY_DETAILS,
                   t.RULES_TRIGGERED_JSON, t.ASSESSMENT_JSON,
                   t.RECOMMENDED_ACTION, t.POLICY_VERSION,
                   t.GENERATED_AT AS SCORED_AT
            FROM "{_EMBED_SCHEMA}"."RISK_ASSESSMENTS" t
            LEFT JOIN "{_HANA_SCHEMA}"."RISK_ALERTS" a ON a.TRANSACTION_ID = t.TRANSACTION_ID
            {where_clause}
            ORDER BY t.GENERATED_AT DESC
            """,
            tuple(params)
        )
        row = cur.fetchone()
        if not row:
            return {
                "skill": "explain_risk_score_skill", 
                "error": "No risk assessment or alert record found matching the provided IDs.",
                "diagnostic": f"Tried assessment_id={assessment_id}, alert_id={alert_id}, transaction_id={transaction_id}"
            }
        
        cols = [d[0] for d in cur.description]
        alert_data = dict(zip(cols, [str(v) if v is not None else None for v in row]))

        # RAG Vector context
        from backend.vectorembedding import search_similar_texts
        rag_hits = search_similar_texts(
            table_name="RISK_ALERTS",
            text_col="ALERT_DESCRIPTION",
            query=alert_data.get("ALERT_DESCRIPTION") or "",
            top_k=3,
            return_cols=["ALERT_DESCRIPTION", "ALERT_TYPE", "ALERT_PRIORITY"]
        )

        return {
            "skill": "explain_risk_score_skill",
            "alert_and_risk_data": alert_data,
            "similar_historical_alerts": rag_hits
        }
    finally:
        cur.close()
        conn.close()

# ---------------------------------------------------------------------------
# Skill 3: Run Screening Check
# ---------------------------------------------------------------------------
def _normalize_entity_name(value: Any) -> str:
    normalized = re.sub(
        r"(?i)\b(inc|incorporated|ltd|limited|llc|trust|corp|corporation|plc)\b\.?",
        "",
        str(value or ""),
    )
    return " ".join(re.sub(r"[^\w]+", " ", normalized.lower()).split())


def _fuzzy_entity_match(search_name: str, entity_name: Any, aliases: Any) -> bool:
    needle = _normalize_entity_name(search_name)
    if not needle:
        return False

    candidates = [entity_name]
    candidates.extend(re.split(r"[,;|/]", str(aliases or "")))
    for candidate in candidates:
        normalized_candidate = _normalize_entity_name(candidate)
        if not normalized_candidate:
            continue
        if needle == normalized_candidate:
            return True
        if min(len(needle), len(normalized_candidate)) >= 4 and (
            needle in normalized_candidate or normalized_candidate in needle
        ):
            return True
        if SequenceMatcher(None, needle, normalized_candidate).ratio() >= 0.84:
            return True
    return False


def _database_flag(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y"}


def _parse_rule_list(value: Any) -> list[dict]:
    if not value:
        return []
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return [rule for rule in parsed if isinstance(rule, dict)] if isinstance(parsed, list) else []


def _parse_json_object(value: Any) -> dict:
    if not value:
        return {}
    try:
        parsed = json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def run_screening_check_skill(
    entity_name: str,
    alert_id: str = None,
    transaction_id: str = None,
    assessment_id: str = None,
) -> dict:
    """Queries SANCTIONS_LISTS and SCREENING_RULES for hits related to entity and beneficial owners."""
    conn = _get_conn()
    cur = conn.cursor()
    try:
        names_to_search = [entity_name] if entity_name else []
        company_ids = set()
        owner_screening_flags = []

        # Resolve alert_id to transaction_id if transaction_id is missing
        if alert_id and not transaction_id:
            cur.execute(f'SELECT TRANSACTION_ID FROM "{_HANA_SCHEMA}"."RISK_ALERTS" WHERE ALERT_ID = ?', (alert_id,))
            row = cur.fetchone()
            if row and row[0]:
                transaction_id = row[0]

        if transaction_id:
            cur.execute(f'SELECT ORIGINATOR_COMPANY_ID, BENEFICIARY_COMPANY_ID FROM "{_HANA_SCHEMA}"."TRANSACTIONS" WHERE TRANSACTION_ID = ?', (transaction_id,))
            tx_row = cur.fetchone()
            if tx_row:
                if tx_row[0]:
                    company_ids.add(tx_row[0])
                if tx_row[1]:
                    company_ids.add(tx_row[1])

        for cid in sorted(company_ids, key=str):
            cur.execute(f'SELECT LEGAL_NAME FROM "{_HANA_SCHEMA}"."COMPANIES" WHERE COMPANY_ID = ?', (cid,))
            comp_row = cur.fetchone()
            if comp_row and comp_row[0]:
                names_to_search.append(comp_row[0])

            cur.execute(
                f"""
                SELECT OWNER_NAME, IS_PEP, SANCTIONS_MATCH
                FROM "{_HANA_SCHEMA}"."COMPANY_BENEFICIAL_OWNERS"
                WHERE COMPANY_ID = ?
                """,
                (cid,),
            )
            for bo_row in cur.fetchall():
                if bo_row[0]:
                    names_to_search.append(bo_row[0])
                    owner_screening_flags.append({
                        "owner_name": str(bo_row[0]),
                        "is_pep": _database_flag(bo_row[1]),
                        "sanctions_match": _database_flag(bo_row[2]),
                    })

        names_to_search = sorted(
            {str(name) for name in names_to_search if name is not None and str(name).strip()},
            key=str.casefold,
        )

        hit_map = {}
        sanc_cols = ['SANCTIONS_ID', 'LIST_SOURCE', 'ENTITY_TYPE', 'ENTITY_NAME', 'ALIASES', 'PROGRAM', 'SANCTIONS_TYPE']

        if names_to_search:
            cur.execute(
                f"""
                SELECT SANCTIONS_ID, LIST_SOURCE, ENTITY_TYPE, ENTITY_NAME, ALIASES, PROGRAM, SANCTIONS_TYPE
                FROM "{_HANA_SCHEMA}"."SANCTIONS_LISTS"
                """
            )
            for r in cur.fetchall():
                hit = dict(zip(sanc_cols, [str(v) if v is not None else None for v in r]))
                matched_names = [
                    name
                    for name in names_to_search
                    if _fuzzy_entity_match(name, hit.get("ENTITY_NAME"), hit.get("ALIASES"))
                ]
                if not matched_names:
                    continue
                record_key = hit.get("SANCTIONS_ID") or tuple(
                    hit.get(column) for column in sanc_cols
                )
                if record_key not in hit_map:
                    hit["matched_on_names"] = matched_names
                    hit_map[record_key] = hit
                else:
                    hit_map[record_key]["matched_on_names"].extend(matched_names)

        sanctions_hits = sorted(
            hit_map.values(),
            key=lambda hit: str(hit.get("SANCTIONS_ID") or ""),
        )
        for hit in sanctions_hits:
            hit["matched_on_names"] = sorted(set(hit["matched_on_names"]))

        assessment_rules = []
        if assessment_id or transaction_id:
            where_clause = '"ASSESSMENT_ID" = ?' if assessment_id else '"TRANSACTION_ID" = ?'
            assessment_key = assessment_id or transaction_id
            cur.execute(
                f"""
                SELECT TOP 1 "RULES_TRIGGERED_JSON"
                FROM "{_EMBED_SCHEMA}"."RISK_ASSESSMENTS"
                WHERE {where_clause}
                ORDER BY "GENERATED_AT" DESC
                """,
                (assessment_key,),
            )
            assessment_row = cur.fetchone()
            if assessment_row:
                assessment_rules = _parse_rule_list(assessment_row[0])

        override_rule_ids = sorted({
            str(rule.get("ruleId") or rule.get("rule_id"))
            for rule in assessment_rules
            if isinstance(rule, dict)
            and rule.get("ruleId", rule.get("rule_id"))
            and any(
                marker in str(rule.get("ruleId") or rule.get("rule_id")).upper()
                for marker in ("SANCTION", "PEP")
            )
        })
        flagged_owners = [
            flag for flag in owner_screening_flags
            if flag["is_pep"] or flag["sanctions_match"]
        ]
        requires_manual_review = bool(
            sanctions_hits or override_rule_ids or flagged_owners
        )

        return {
            "skill": "run_screening_check_skill",
            "entities_searched": names_to_search,
            "sanctions_hits": sanctions_hits,
            "hit_count": len(sanctions_hits),
            "beneficial_owner_flags": flagged_owners,
            "assessment_override_rules": override_rule_ids,
            "requires_manual_review": requires_manual_review,
            "screening_coverage": {
                "sanctions": "SANCTIONS_LISTS plus beneficial-owner sanctions flags",
                "pep": "beneficial-owner PEP flags only",
                "adverse_media": "not_checked",
            },
        }
    finally:
        cur.close()
        conn.close()

# ---------------------------------------------------------------------------
# Skill 4: Assemble & Draft Case
# ---------------------------------------------------------------------------
def assemble_and_draft_case_skill(
    case_id: str = None,
    alert_id: str = None,
    transaction_id: str = None,
    assessment_id: str = None,
) -> dict:
    """Aggregates transaction history, alerts, into a case summary."""
    conn = _get_conn()
    cur = conn.cursor()
    try:
        case_data = {}
        alerts_data = []
        transactions_data = []
        assessment_context = {}

        tx_id_to_fetch = transaction_id

        if case_id:
            cur.execute(
                f"""
                SELECT CASE_ID, CASE_NUMBER, CASE_TYPE, CASE_PRIORITY, CASE_TITLE,
                       CASE_SUMMARY, TOTAL_FLAGGED_AMOUNT, STATUS, COMPANY_ID
                FROM "{_HANA_SCHEMA}"."COMPLIANCE_CASES"
                WHERE CASE_ID = ?
                """, (case_id,)
            )
            row = cur.fetchone()
            if row:
                cols = [d[0] for d in cur.description]
                case_data = dict(zip(cols, [str(v) if v is not None else None for v in row]))

                # Try to fetch alerts related to this company (simple heuristic)
                if "COMPANY_ID" in case_data and case_data["COMPANY_ID"]:
                    cur.execute(
                        f"""
                        SELECT TOP 5 ALERT_ID, ALERT_TYPE, ALERT_PRIORITY, STATUS, TRANSACTION_ID
                        FROM "{_HANA_SCHEMA}"."RISK_ALERTS"
                        WHERE COMPANY_ID = ?
                        ORDER BY CREATED_AT DESC
                        """, (case_data["COMPANY_ID"],)
                    )
                    alert_rows = cur.fetchall()
                    alerts_data = [dict(zip([d[0] for d in cur.description], [str(v) if v is not None else None for v in r])) for r in alert_rows]

                    if alerts_data and not tx_id_to_fetch:
                        tx_id_to_fetch = alerts_data[0].get("TRANSACTION_ID")

        # Fallback if no case found
        if not case_data and (alert_id or transaction_id):
            if alert_id:
                cur.execute(
                    f"""
                    SELECT ALERT_ID, ALERT_TYPE, ALERT_PRIORITY, ALERT_DESCRIPTION, TRANSACTION_ID, COMPANY_ID
                    FROM "{_HANA_SCHEMA}"."RISK_ALERTS"
                    WHERE ALERT_ID = ?
                    """, (alert_id,)
                )
            else:
                cur.execute(
                    f"""
                    SELECT ALERT_ID, ALERT_TYPE, ALERT_PRIORITY, ALERT_DESCRIPTION, TRANSACTION_ID, COMPANY_ID
                    FROM "{_HANA_SCHEMA}"."RISK_ALERTS"
                    WHERE TRANSACTION_ID = ?
                    """, (transaction_id,)
                )
            row = cur.fetchone()
            if row:
                cols = [d[0] for d in cur.description]
                alerts_data = [dict(zip(cols, [str(v) if v is not None else None for v in row]))]
                tx_id_to_fetch = alerts_data[0].get("TRANSACTION_ID") or tx_id_to_fetch
                
        if tx_id_to_fetch:
            cur.execute(
                f"""
                SELECT TRANSACTION_ID, TRANSACTION_REF, AMOUNT_USD, CURRENCY_ORIGINAL, IS_CROSS_BORDER
                FROM "{_HANA_SCHEMA}"."TRANSACTIONS"
                WHERE TRANSACTION_ID = ?
                """, (tx_id_to_fetch,)
            )
            tx_row = cur.fetchone()
            if tx_row:
                transactions_data = [dict(zip([d[0] for d in cur.description], [str(v) if v is not None else None for v in tx_row]))]

        if assessment_id or tx_id_to_fetch:
            assessment_filter = '"ASSESSMENT_ID" = ?' if assessment_id else '"TRANSACTION_ID" = ?'
            assessment_key = assessment_id or tx_id_to_fetch
            cur.execute(
                f"""
                SELECT TOP 1 "ASSESSMENT_JSON", "OVERALL_SCORE", "RISK_LEVEL",
                             "RECOMMENDED_ACTION", "POLICY_VERSION"
                FROM "{_EMBED_SCHEMA}"."RISK_ASSESSMENTS"
                WHERE {assessment_filter}
                ORDER BY "GENERATED_AT" DESC
                """,
                (assessment_key,),
            )
            assessment_row = cur.fetchone()
            if assessment_row:
                assessment_payload = _parse_json_object(assessment_row[0])
                assessment_context = {
                    "overall_score": str(assessment_row[1]) if assessment_row[1] is not None else None,
                    "risk_level": str(assessment_row[2]) if assessment_row[2] is not None else None,
                    "recommended_action": str(assessment_row[3]) if assessment_row[3] is not None else None,
                    "policy_version": str(assessment_row[4]) if assessment_row[4] is not None else None,
                    "hard_overrides": assessment_payload.get("hardOverrides", []),
                }

        return {
            "skill": "assemble_and_draft_case_skill",
            "case_metadata": case_data,
            "related_alerts": alerts_data,
            "related_transactions": transactions_data,
            "assessment_context": assessment_context,
        }
    finally:
        cur.close()
        conn.close()

# ---------------------------------------------------------------------------
# Skill 5: Check Aging Escalations
# ---------------------------------------------------------------------------
def check_aging_escalations_skill(threshold_days: int = 30) -> dict:
    """Identifies open cases whose compliance remediation SLA is overdue."""
    conn = _get_conn()
    cur = conn.cursor()
    try:
        as_of_date = datetime.now().strftime('%Y-%m-%d')
        cur.execute(
            f"""
            SELECT CASE_ID, CASE_NUMBER, CASE_PRIORITY, STATUS, DUE_DATE, ASSIGNED_ANALYST
            FROM "{_HANA_SCHEMA}"."COMPLIANCE_CASES"
            WHERE STATUS != 'CLOSED' AND DUE_DATE <= ?
            ORDER BY DUE_DATE ASC
            """,
            (as_of_date,)
        )
        rows = cur.fetchall()
        cols = [d[0] for d in cur.description]
        stale_cases = [dict(zip(cols, [str(v) if v is not None else None for v in r])) for r in rows]

        return {
            "skill": "check_aging_escalations_skill",
            "as_of_date": as_of_date,
            "scope": "overdue_open_cases",
            "stale_cases": stale_cases,
            "count": len(stale_cases)
        }
    finally:
        cur.close()
        conn.close()


# ---------------------------------------------------------------------------
# Orchestrator Router
# ---------------------------------------------------------------------------
class AgentIntent:
    TRIAGE = "triage_queue"
    EXPLAIN_SCORE = "explain_risk_score"
    SCREENING = "screening_check"
    DRAFT_CASE = "draft_case"
    AGING_ESCALATIONS = "aging_escalations"
    GENERAL = "general"

def _route_skill(query: str, active_context: dict) -> tuple[str, dict]:
    """Routes the query to the correct skill and returns the extracted context."""
    q_lower = query.lower()
    
    # Helper to extract numeric IDs
    def _clean_id(val: Any) -> Optional[str]:
        if not val:
            return None
        cleaned = re.sub(r'\D', '', str(val))
        return cleaned if cleaned else str(val)

    # Check context first
    alert_id = _clean_id(active_context.get("alert_id"))
    case_id = _clean_id(active_context.get("case_id"))
    transaction_id = _clean_id(active_context.get("transaction_id"))
    entity_name = active_context.get("entity_name")
    
    # Assessment ID might be a UUID, so don't strip non-digits
    assessment_id = str(active_context.get("assessment_id")) if active_context.get("assessment_id") else None

    # Off-topic / conversational gate
    off_topic_words = {"weather", "sports", "recipe", "joke"}
    query_words = set(re.findall(r'\w+', q_lower))
    if off_topic_words.intersection(query_words) or q_lower.strip() in ["hi", "hello", "hey", "how are you"]:
        return AgentIntent.GENERAL, {}

    if "queue" in q_lower or "triage" in q_lower or "prioritize" in q_lower or "pending" in q_lower:
        return AgentIntent.TRIAGE, get_triage_queue_skill()
    
    if "age" in q_lower or "stale" in q_lower or "sla" in q_lower or "escalat" in q_lower or "deadline" in q_lower:
        return AgentIntent.AGING_ESCALATIONS, check_aging_escalations_skill(30)
    
    if "screen" in q_lower or "sanction" in q_lower or "pep" in q_lower or "adverse media" in q_lower:
        # Extract potential entity name if not in context
        ent = entity_name
        if not ent and not alert_id and not transaction_id:
            # simple heuristic: look for capitalized words or just use a default test name
            ent = "Acme" # default fallback
            match = re.search(r'for\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)', query)
            if match:
                ent = match.group(1)
        return AgentIntent.SCREENING, run_screening_check_skill(
            ent,
            alert_id=alert_id,
            transaction_id=transaction_id,
            assessment_id=assessment_id,
        )
    
    if "draft" in q_lower or "assemble" in q_lower or "summary" in q_lower or "narrative" in q_lower or "case" in q_lower:
        # if the user just asks for case and has a case ID, prefer draft_case
        if case_id or alert_id or transaction_id:
            return AgentIntent.DRAFT_CASE, assemble_and_draft_case_skill(
                case_id=case_id,
                alert_id=alert_id,
                transaction_id=transaction_id,
                assessment_id=assessment_id,
            )
        elif "case" in q_lower:
            return AgentIntent.DRAFT_CASE, assemble_and_draft_case_skill()
    
    # Require explicit keywords to trigger EXPLAIN_SCORE intent
    explain_keywords = {"explain", "driver", "drivers", "score", "breakdown"}
    why_context_words = {"alert", "flagged", "risk", "score", "transaction", "assessment"}
    requests_explanation = bool(explain_keywords.intersection(query_words)) or (
        "why" in query_words and bool(why_context_words.intersection(query_words))
    )
    if requests_explanation:
        if alert_id or assessment_id or transaction_id:
            return AgentIntent.EXPLAIN_SCORE, explain_risk_score_skill(alert_id=alert_id, assessment_id=assessment_id, transaction_id=transaction_id)
        else:
            # Fallback if no specific ID provided
            return AgentIntent.EXPLAIN_SCORE, explain_risk_score_skill()
    
    return AgentIntent.GENERAL, {}


# ---------------------------------------------------------------------------
# Strict JSON Enforcement
# ---------------------------------------------------------------------------
def _extract_and_repair_json(raw: str) -> dict:
    text = re.sub(r"```(?:json)?\s*", "", raw).strip().rstrip("`").strip()
    
    # Find first { ... }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end+1]
        
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Regex structural fallback
        title_m = re.search(r'"title"\s*:\s*"([^"]+)"', raw)
        rec_m = re.search(r'"recommendation"\s*:\s*"([^"]+)"', raw)
        sections = []
        for m in re.finditer(r'"label"\s*:\s*"([^"]+)"[^}]*"content"\s*:\s*"([^"]*)"', raw, re.S):
            sections.append({"label": m.group(1), "content": m.group(2)})
        
        data = {
            "title": title_m.group(1) if title_m else "Joule Analysis",
            "sections": sections or [{"label": "Analysis", "content": raw[:500]}],
            "recommendation": rec_m.group(1) if rec_m else "Consult compliance officer.",
            "risk_factors": []
        }
        
    # Validate schema
    clean_sections = []
    for i, s in enumerate(data.get("sections", [])):
        if isinstance(s, dict):
            clean_sections.append({
                "label": str(s.get("label", f"Section {i+1}")),
                "content": str(s.get("content", ""))
            })
            
    clean_risk_factors = []
    for f in data.get("risk_factors", []):
        if isinstance(f, dict):
            try:
                raw_score = float(f.get("score", 0.0))
            except (ValueError, TypeError):
                raw_score = 0.0
            try:
                raw_weight = float(f.get("weight", 0.0))
            except (ValueError, TypeError):
                raw_weight = 0.0
                
            clean_risk_factors.append({
                "name": str(f.get("name", "Unknown Risk")),
                "score": max(0.0, min(100.0, raw_score)),
                "weight": max(0.0, min(1.0, raw_weight)),
                "rationale": str(f.get("rationale", ""))
            })
    
    return {
        "title": str(data.get("title", "Joule Analysis")),
        "sections": clean_sections or [{"label": "Analysis", "content": "See recommendation."}],
        "recommendation": str(data.get("recommendation", "")),
        "risk_factors": clean_risk_factors
    }


# ---------------------------------------------------------------------------
# Unified Agent Orchestrator
# ---------------------------------------------------------------------------
def process_joule_query(user_query: str, active_context: Optional[dict] = None) -> dict:
    """
    Unified Agent Orchestrator
    Routes to the correct skill, gathers facts, synthesizes using GPT-4o,
    and returns a strict JSON UI schema.
    """
    from backend.orchestration_config import run_orchestrated_prompt

    ctx = active_context or {}
    
    # 1. Route and execute skill
    intent, skill_data = _route_skill(user_query, ctx)

    # 2. Short-circuit for GENERAL intent to avoid LLM hallucination and latency
    if intent == AgentIntent.GENERAL:
        return {
            "title": "Agent Notification",
            "sections": [
                {
                    "label": "Notice",
                    "content": "I'm sorry, I can't answer this as I am a Compliance & AML Custom Agent designed strictly for risk and alert analysis. I'd be happy to help analyze this alert for you!"
                }
            ],
            "recommendation": "Please ask a compliance-related question.",
            "risk_factors": [],
            "_meta": {
                "intent": intent,
                "skill_executed": "none"
            }
        }

    # 3. Build Prompt
    system_prompt = (
        "You are Joule, a Compliance & AML Custom Agent. "
        "Your task is to analyze the user query and the provided JSON facts from backend skills. "
        "If the user asks an off-topic question (e.g., weather, sports, general chat), politely and warmly acknowledge the query with a light, friendly refusal before transitioning back to compliance (e.g., 'I can't check the weather forecast, but I'd be happy to help analyze this alert for you!'). "
        "When explaining risk breakdowns, always use the user-facing display labels (e.g., 'Compliance & counterparty risk') instead of raw DB column identifiers. "
        "The mappings are: AMOUNT_RISK_SCORE -> 'Amount risk', FREQUENCY_RISK_SCORE -> 'Other behavioural / industry risk', GEOGRAPHY_RISK_SCORE -> 'Geographic risk', COUNTERPARTY_RISK_SCORE -> 'Compliance & counterparty risk', PATTERN_RISK_SCORE -> 'Transaction-pattern risk', VELOCITY_RISK_SCORE -> 'Velocity risk'. "
        "Clearly distinguish the source alert score/type from the current persisted assessment score and the separate SAP AI anomaly signal. "
        "For screening responses, never claim that PEP or adverse-media checks were completed unless the skill facts explicitly mark that coverage. Never recommend clearance when requires_manual_review is true. "
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

    context_str = json.dumps(skill_data, indent=2)
    user_prompt = f"User Query: {user_query}\n\nSkill Execution Facts:\n{context_str}\n\nSynthesize the facts and answer the query in the exact JSON format requested."

    # 3. Call Orchestration (GPT-4o + Masking + Filtering)
    raw_response = run_orchestrated_prompt(
        system_instruction=system_prompt,
        user_prompt=user_prompt,
        enable_masking=True,
        enable_filtering=True,
        max_tokens=1024
    )

    # 4. Enforce strict JSON output
    result = _extract_and_repair_json(raw_response)
    
    # Deterministically override risk_factors if this was an explanation
    if intent == AgentIntent.EXPLAIN_SCORE:
        risk_data = skill_data.get("alert_and_risk_data", {})
        db_factors = {
            "Amount risk": float(risk_data.get("AMOUNT_RISK_SCORE") or 0.0),
            "Geographic risk": float(risk_data.get("GEOGRAPHY_RISK_SCORE") or 0.0),
            "Compliance & counterparty risk": float(risk_data.get("COUNTERPARTY_RISK_SCORE") or 0.0),
            "Transaction-pattern risk": float(risk_data.get("PATTERN_RISK_SCORE") or 0.0),
            "Velocity risk": float(risk_data.get("VELOCITY_RISK_SCORE") or 0.0),
            "Other behavioural / industry risk": float(risk_data.get("FREQUENCY_RISK_SCORE") or 0.0)
        }
        
        # Merge LLM rationales with DB scores
        llm_factors = {f["name"].lower(): f.get("rationale", "") for f in result.get("risk_factors", [])}
        
        final_factors = []
        for name, score in db_factors.items():
            if score > 0:
                # Fallback rationale if LLM didn't generate one for this specific name
                rationale = llm_factors.get(name.lower(), f"Elevated {name.lower()} detected based on transaction patterns.")
                final_factors.append({
                    "name": name,
                    "score": score,
                    "weight": max(0.0, min(1.0, score / 100.0)),
                    "rationale": rationale
                })
        
        result["risk_factors"] = final_factors

        assessment_payload = _parse_json_object(risk_data.get("ASSESSMENT_JSON"))
        score_breakdown = assessment_payload.get("scoreBreakdown")
        if not isinstance(score_breakdown, dict):
            score_breakdown = {}
        model_signals = assessment_payload.get("modelSignals")
        if not isinstance(model_signals, dict):
            model_signals = _parse_json_object(risk_data.get("ANOMALY_DETAILS"))
        anomaly_flag = model_signals.get("anomalyFlag")
        model_status = model_signals.get("status")
        anomaly_score = score_breakdown.get("anomalyScore")
        has_source_alert = any(
            risk_data.get(field)
            for field in ("ALERT_ID", "ALERT_TYPE", "ALERT_DESCRIPTION")
        )
        if has_source_alert:
            source_context = (
                f"The source alert is {risk_data.get('ALERT_TYPE') or 'unspecified'} and its "
                f"original description is: "
                f"{risk_data.get('ALERT_DESCRIPTION') or 'No description provided.'}"
            )
        else:
            source_context = (
                "No source RISK_ALERTS record is linked to this persisted assessment."
            )
            assessment_label = risk_data.get("SCORE_ID")
            result["title"] = (
                f"Risk Score Analysis for Assessment {assessment_label}"
                if assessment_label
                else "Risk Score Analysis for Assessment"
            )

        if model_status == "MODEL_UNAVAILABLE" or anomaly_flag is None:
            anomaly_context = "The SAP AI anomaly signal is unavailable for this assessment."
        else:
            anomaly_context = (
                f"The separate SAP AI anomaly signal is anomalyFlag={anomaly_flag!s} "
                f"with anomaly score "
                f"{anomaly_score if anomaly_score is not None else 'unavailable'}/100."
            )
        score_context = (
            f"{source_context} "
            f"The current persisted assessment is {risk_data.get('OVERALL_RISK_SCORE') or 'unknown'}/100 "
            f"with tier {risk_data.get('RISK_TIER') or 'unknown'}. "
            f"{anomaly_context}"
        )
        result["sections"] = [
            section for section in result["sections"]
            if section.get("label", "").lower() != "score context"
        ]
        result["sections"].insert(0, {
            "label": "Score Context",
            "content": score_context,
        })

        hard_overrides = assessment_payload.get("hardOverrides", [])
        if isinstance(hard_overrides, list) and hard_overrides:
            override_descriptions = []
            for override in hard_overrides:
                if not isinstance(override, dict):
                    continue
                rule_id = str(override.get("ruleId") or "UNKNOWN_OVERRIDE")
                minimum_score = override.get("minimumScore")
                description = str(override.get("description") or rule_id)
                floor_text = (
                    f" and floors the score at {minimum_score}/100"
                    if minimum_score is not None
                    else ""
                )
                override_descriptions.append(
                    f"{rule_id}: {description}{floor_text}"
                )
            if override_descriptions:
                result["sections"] = [
                    section for section in result["sections"]
                    if section.get("label", "").lower() != "hard override"
                ]
                result["sections"].insert(0, {
                    "label": "Hard Override",
                    "content": (
                        "The final score is policy-controlled and cannot be reduced "
                        f"by the weighted rule/anomaly calculation. {'; '.join(override_descriptions)}."
                    ),
                })
                nested_assessment = assessment_payload.get("assessment")
                nested_action = (
                    nested_assessment.get("recommendedAction")
                    if isinstance(nested_assessment, dict)
                    else None
                )
                recommended_action = (
                    risk_data.get("RECOMMENDED_ACTION")
                    or nested_action
                    or "HOLD_AND_ESCALATE"
                )
                result["recommendation"] = (
                    f"Apply {recommended_action}: hold this case and escalate it "
                    "for manual compliance review."
                )
    else:
        result["risk_factors"] = []

    if intent == AgentIntent.SCREENING:
        coverage = skill_data.get("screening_coverage", {})
        coverage_content = (
            f"Sanctions: {coverage.get('sanctions', 'not_checked')}. "
            f"PEP: {coverage.get('pep', 'not_checked')}. "
            f"Adverse media: {coverage.get('adverse_media', 'not_checked')}."
        )
        result["sections"].append({
            "label": "Screening Coverage",
            "content": coverage_content,
        })

        if skill_data.get("requires_manual_review"):
            reasons = []
            override_rules = skill_data.get("assessment_override_rules", [])
            owner_flags = skill_data.get("beneficial_owner_flags", [])
            if override_rules:
                reasons.append(f"assessment override rules: {', '.join(override_rules)}")
            if owner_flags:
                owner_names = sorted({
                    str(flag.get("owner_name"))
                    for flag in owner_flags
                    if flag.get("owner_name")
                })
                reasons.append(f"flagged beneficial owners: {', '.join(owner_names)}")
            if skill_data.get("hit_count", 0):
                reasons.append(f"{skill_data['hit_count']} sanctions-list hit(s)")
            result["sections"].insert(0, {
                "label": "Compliance Override",
                "content": (
                    "Manual review is required because existing compliance data "
                    f"contains {('; '.join(reasons) or 'a screening flag')}."
                ),
            })
            result["recommendation"] = (
                "Do not clear this case. Hold and escalate it for manual compliance "
                "review; adverse-media screening must also be completed separately."
            )
        else:
            result["recommendation"] = (
                "Review the returned sanctions and beneficial-owner PEP results. "
                "Adverse-media screening was not performed and must be completed "
                "separately before clearance."
            )

    if intent == AgentIntent.DRAFT_CASE:
        assessment_context = skill_data.get("assessment_context", {})
        hard_overrides = assessment_context.get("hard_overrides", [])
        if isinstance(hard_overrides, list) and hard_overrides:
            override_ids = sorted({
                str(override.get("ruleId") or "UNKNOWN_OVERRIDE")
                for override in hard_overrides
                if isinstance(override, dict)
            })
            result["sections"] = [
                section for section in result["sections"]
                if section.get("label", "").lower() != "compliance override"
            ]
            overall_score = assessment_context.get("overall_score")
            score_text = f"{overall_score}/100" if overall_score else "policy-controlled"
            result["sections"].insert(0, {
                "label": "Compliance Override",
                "content": (
                    "This case is subject to a hard compliance override: "
                    f"{', '.join(override_ids)}. The final score is "
                    f"{score_text} "
                    f"under policy {assessment_context.get('policy_version') or 'unknown'}."
                ),
            })
            recommended_action = (
                assessment_context.get("recommended_action")
                or "HOLD_AND_ESCALATE"
            )
            result["recommendation"] = (
                f"Apply {recommended_action}: hold this case and escalate it "
                "for manual compliance review."
            )
    
    # Add metadata for debugging
    result["_meta"] = {
        "intent": intent,
        "skill_executed": skill_data.get("skill", "none")
    }

    return result

# ---------------------------------------------------------------------------
# Smoke Test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print("=" * 65)
    print("  Phase 4A: Custom Joule Agent Skills -- Smoke Test")
    print("=" * 65)

    test_cases = [
        {
            "label": "Skill 1: Triage Queue",
            "query": "Show me the triage queue and top priority cases.",
            "ctx": {}
        },
        {
            "label": "Skill 2: Explain Risk Score",
            "query": "Explain the risk drivers for this alert.",
            "ctx": {"alert_id": "15004"}
        },
        {
            "label": "Skill 3: Screening Check",
            "query": "Run a sanctions screening check for Global Nexus.",
            "ctx": {"entity_name": "Global Nexus"}
        },
        {
            "label": "Skill 4: Assemble & Draft Case",
            "query": "Draft a case summary for the current case.",
            "ctx": {"case_id": "10002"}
        },
        {
            "label": "Skill 5: Check Aging Escalations",
            "query": "Are there any stale cases nearing SLA deadlines?",
            "ctx": {}
        }
    ]

    for tc in test_cases:
        print(f"\n{'-'*65}")
        print(f"  {tc['label']}")
        print(f"  Query: {tc['query']}")
        print(f"{'-'*65}")
        
        try:
            result = process_joule_query(tc["query"], tc["ctx"])
            print(f"  Skill Executed: {result.get('_meta', {}).get('skill_executed')}")
            
            schema_only = {k: v for k, v in result.items() if k != "_meta"}
            print(f"\n  JSON Output:\n{json.dumps(schema_only, indent=2)}")
        except Exception as e:
            print(f"  [ERROR] {e}")

    print("\n" + "=" * 65)
    print("  Smoke test complete.")
    print("=" * 65)
