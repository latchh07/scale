import unittest
from unittest.mock import patch, MagicMock

import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from joule_agent import (
    AgentIntent,
    _route_skill,
    process_joule_query,
    get_triage_queue_skill,
    run_screening_check_skill,
    assemble_and_draft_case_skill
)

class TestAgentFixes(unittest.TestCase):
    def test_hi_whats_your_name_routes_to_general(self):
        # Even with alert context, 'hi what's your name' should hit conversational gate
        ctx = {"alert_id": "123", "transaction_id": "456"}
        intent, data = _route_skill("hi what's your name", ctx)
        self.assertEqual(intent, AgentIntent.GENERAL)
        self.assertEqual(data, {})

    def test_context_alone_does_not_trigger_explain_score(self):
        # Query missing explicit keywords but having context shouldn't hit EXPLAIN_SCORE
        ctx = {"alert_id": "123"}
        intent, data = _route_skill("give me the details", ctx)
        # Without "explain", "driver", "score", etc., it falls through to GENERAL
        self.assertEqual(intent, AgentIntent.GENERAL)
        self.assertEqual(data, {})

    def test_off_topic_why_question_routes_to_general(self):
        ctx = {"alert_id": "123", "transaction_id": "456"}
        intent, data = _route_skill("Why is the sky blue?", ctx)
        self.assertEqual(intent, AgentIntent.GENERAL)
        self.assertEqual(data, {})

    def test_general_requests_call_neither_gpt4_nor_db_skills(self):
        with (
            patch("backend.orchestration_config.run_orchestrated_prompt") as mock_prompt,
            patch("joule_agent.get_triage_queue_skill") as mock_triage,
            patch("joule_agent.explain_risk_score_skill") as mock_explain,
            patch("joule_agent.run_screening_check_skill") as mock_screen,
            patch("joule_agent.assemble_and_draft_case_skill") as mock_draft,
            patch("joule_agent.check_aging_escalations_skill") as mock_aging,
        ):
            result = process_joule_query(
                "hi what's your name",
                {"alert_id": "123", "transaction_id": "456"},
            )

        mock_prompt.assert_not_called()
        mock_triage.assert_not_called()
        mock_explain.assert_not_called()
        mock_screen.assert_not_called()
        mock_draft.assert_not_called()
        mock_aging.assert_not_called()
        self.assertEqual(result["title"], "Agent Notification")
        self.assertEqual(result["risk_factors"], [])
        self.assertEqual(result["_meta"]["intent"], AgentIntent.GENERAL)

    @patch("backend.orchestration_config.run_orchestrated_prompt")
    def test_explain_score_factors_weight_calculation(self, mock_prompt):
        # Mock GPT response for process_joule_query
        mock_prompt.return_value = '''{
            "title": "Explain Analysis",
            "sections": [],
            "recommendation": "None",
            "risk_factors": [{"name": "Amount risk", "rationale": "High value"}]
        }'''
        
        # We need to mock _route_skill returning EXPLAIN_SCORE with specific DB scores
        with patch("joule_agent._route_skill") as mock_route:
            mock_route.return_value = (AgentIntent.EXPLAIN_SCORE, {
                "skill": "explain_risk_score_skill",
                "alert_and_risk_data": {
                    "AMOUNT_RISK_SCORE": "85.0",
                    "GEOGRAPHY_RISK_SCORE": "0.0",
                    "COUNTERPARTY_RISK_SCORE": "25.0",
                    "ALERT_TYPE": "VELOCITY_ANOMALY",
                    "ALERT_DESCRIPTION": "Risk score 84 exceeded threshold.",
                    "OVERALL_RISK_SCORE": "100",
                    "RISK_TIER": "CRITICAL",
                    "RECOMMENDED_ACTION": "HOLD_AND_ESCALATE",
                    "ASSESSMENT_JSON": """{
                        "scoreBreakdown": {"anomalyScore": 60},
                        "modelSignals": {"anomalyFlag": false},
                        "hardOverrides": [{
                            "ruleId": "BENEFICIAL_OWNER_SANCTIONS_MATCH",
                            "description": "Confirmed beneficial-owner sanctions match",
                            "minimumScore": 100
                        }]
                    }"""
                }
            })
            
            result = process_joule_query("explain score", {"alert_id": "123"})
            
            # Check weights
            rf = {f["name"]: f for f in result["risk_factors"]}
            self.assertIn("Amount risk", rf)
            self.assertEqual(rf["Amount risk"]["score"], 85.0)
            self.assertEqual(rf["Amount risk"]["weight"], 0.85) # 85 / 100
            
            self.assertIn("Compliance & counterparty risk", rf)
            self.assertEqual(rf["Compliance & counterparty risk"]["weight"], 0.25) # 25 / 100
            sections = {section["label"]: section["content"] for section in result["sections"]}
            self.assertIn("Score Context", sections)
            self.assertIn("Risk score 84 exceeded threshold", sections["Score Context"])
            self.assertIn("100/100", sections["Score Context"])
            self.assertIn("anomalyFlag=False", sections["Score Context"])
            self.assertIn("Hard Override", sections)
            self.assertIn("BENEFICIAL_OWNER_SANCTIONS_MATCH", sections["Hard Override"])
            self.assertIn("HOLD_AND_ESCALATE", result["recommendation"])

    @patch("backend.orchestration_config.run_orchestrated_prompt")
    def test_explain_without_linked_alert_uses_assessment_fallback(self, mock_prompt):
        mock_prompt.return_value = """{
            "title": "Risk Score Analysis for Alert",
            "sections": [{"label": "Overview", "content": "Assessment details."}],
            "recommendation": "Manual review.",
            "risk_factors": []
        }"""
        skill_data = {
            "skill": "explain_risk_score_skill",
            "alert_and_risk_data": {
                "SCORE_ID": "assessment-123",
                "OVERALL_RISK_SCORE": "100",
                "RISK_TIER": "CRITICAL",
                "ASSESSMENT_JSON": """{
                    "scoreBreakdown": {"anomalyScore": null},
                    "modelSignals": {"status": "MODEL_UNAVAILABLE"},
                    "hardOverrides": []
                }""",
            },
        }

        with patch("joule_agent._route_skill") as mock_route:
            mock_route.return_value = (AgentIntent.EXPLAIN_SCORE, skill_data)
            result = process_joule_query("explain the score", {})

        self.assertEqual(
            result["title"],
            "Risk Score Analysis for Assessment assessment-123",
        )
        sections = {section["label"]: section["content"] for section in result["sections"]}
        self.assertIn("No source RISK_ALERTS record", sections["Score Context"])
        self.assertIn("SAP AI anomaly signal is unavailable", sections["Score Context"])
        self.assertNotIn("anomalyFlag=None", sections["Score Context"])
        self.assertNotIn("unavailable/100", sections["Score Context"])

    @patch("joule_agent._get_conn")
    def test_triage_is_global_and_uses_explicit_priority_ordering(self, mock_conn):
        mock_cur = MagicMock()
        mock_conn.return_value.cursor.return_value = mock_cur
        mock_cur.fetchall.side_effect = [[], []]
        mock_cur.description = []

        get_triage_queue_skill()

        transaction_sql = mock_cur.execute.call_args_list[0].args[0]
        case_sql = mock_cur.execute.call_args_list[1].args[0]
        self.assertNotIn("ASSESSMENT_ID = ?", transaction_sql)
        self.assertIn("ORDER BY OVERALL_SCORE DESC, GENERATED_AT DESC", transaction_sql)
        self.assertIn("CASE UPPER(CASE_PRIORITY)", case_sql)
        self.assertIn("WHEN 'HIGH' THEN 3", case_sql)

        with patch("joule_agent.get_triage_queue_skill") as mock_triage:
            mock_triage.return_value = {"skill": "get_triage_queue_skill"}
            intent, _ = _route_skill(
                "Show me the triage queue",
                {"assessment_id": "active-assessment"},
            )
        self.assertEqual(intent, AgentIntent.TRIAGE)
        mock_triage.assert_called_once_with()

    @patch("joule_agent._get_conn")
    def test_missing_case_id_falls_back_to_transaction_id(self, mock_conn):
        mock_cur = MagicMock()
        mock_conn.return_value.cursor.return_value = mock_cur
        
        # 1st execute: case_id lookup (returns None)
        # 2nd execute: fallback to alert_id/transaction_id lookup
        # 3rd execute: transactions_data lookup
        def side_effect(*args, **kwargs):
            query = args[0]
            if "COMPLIANCE_CASES" in query:
                mock_cur.fetchone.return_value = None
            elif "RISK_ALERTS" in query:
                mock_cur.description = [("ALERT_ID",), ("TRANSACTION_ID",)]
                mock_cur.fetchone.return_value = ("A1", "T1")
            elif "TRANSACTIONS" in query:
                mock_cur.description = [("TRANSACTION_ID",)]
                mock_cur.fetchone.return_value = ("T1",)
            elif "RISK_ASSESSMENTS" in query:
                mock_cur.fetchone.return_value = (
                    '{"hardOverrides": []}',
                    80,
                    "HIGH",
                    "PRIORITY_REVIEW",
                    "2.1.0",
                )
        
        mock_cur.execute.side_effect = side_effect
        
        res = assemble_and_draft_case_skill(case_id="INVALID_CASE", transaction_id="T1")
        
        # Assert fallback was successful
        self.assertEqual(res["case_metadata"], {})
        self.assertEqual(len(res["related_alerts"]), 1)
        self.assertEqual(len(res["related_transactions"]), 1)
        self.assertEqual(res["related_alerts"][0]["TRANSACTION_ID"], "T1")

    @patch("joule_agent._get_conn")
    def test_both_originator_and_beneficiary_screened_and_deduplicated(self, mock_conn):
        mock_cur = MagicMock()
        mock_conn.return_value.cursor.return_value = mock_cur
        
        # Mocking the sequential queries in run_screening_check_skill
        def execute_side_effect(*args, **kwargs):
            query = args[0]
            if "RISK_ALERTS" in query:
                mock_cur.fetchone.return_value = ("TX_1",)
            elif "TRANSACTIONS" in query:
                mock_cur.fetchone.return_value = ("C_ORIG", "C_BENEF")
            elif "COMPANIES" in query:
                if "C_ORIG" in args[1]: mock_cur.fetchone.return_value = ("OrigCorp",)
                else: mock_cur.fetchone.return_value = ("BenefCorp",)
            elif "COMPANY_BENEFICIAL_OWNERS" in query:
                if "C_ORIG" in args[1]:
                    mock_cur.fetchall.return_value = [("Alice", False, False)]
                else:
                    mock_cur.fetchall.return_value = [(12345, False, False)]
            elif "SANCTIONS_LISTS" in query:
                # Return the SAME sanctions ID for multiple different names to test deduplication
                mock_cur.fetchall.return_value = [
                    (
                        "SANC_001",
                        "ListA",
                        "Person",
                        "OrigCorp",
                        "Alice; 12345; BenefCorp",
                        "Prog",
                        "Type",
                    )
                ]
            elif "RISK_ASSESSMENTS" in query:
                mock_cur.fetchone.return_value = (None,)
                
        mock_cur.execute.side_effect = execute_side_effect
        
        res = run_screening_check_skill(entity_name=None, alert_id="A1")
        
        # 1. Check Entities Searched
        self.assertCountEqual(res["entities_searched"], ["OrigCorp", "Alice", "BenefCorp", "12345"])
        
        # 2. Check Deduplication by SANCTIONS_ID
        self.assertEqual(len(res["sanctions_hits"]), 1)
        hit = res["sanctions_hits"][0]
        self.assertEqual(hit["SANCTIONS_ID"], "SANC_001")
        
        # 3. Check matched_on_names
        # The same SANC_001 record was returned 4 times (once for each name), so it should aggregate them
        self.assertEqual(len(hit["matched_on_names"]), 4)
        self.assertCountEqual(hit["matched_on_names"], ["OrigCorp", "Alice", "BenefCorp", "12345"])

    @patch("backend.orchestration_config.run_orchestrated_prompt")
    def test_screening_override_prevents_clearance_recommendation(self, mock_prompt):
        mock_prompt.return_value = """{
            "title": "Screening Check Results",
            "sections": [{"label": "Sanctions Hits", "content": "No hits found."}],
            "recommendation": "No further action required.",
            "risk_factors": []
        }"""
        skill_data = {
            "skill": "run_screening_check_skill",
            "sanctions_hits": [],
            "hit_count": 0,
            "beneficial_owner_flags": [],
            "assessment_override_rules": ["BENEFICIAL_OWNER_SANCTIONS_MATCH"],
            "requires_manual_review": True,
            "screening_coverage": {
                "sanctions": "SANCTIONS_LISTS plus beneficial-owner sanctions flags",
                "pep": "beneficial-owner PEP flags only",
                "adverse_media": "not_checked",
            },
        }

        with patch("joule_agent._route_skill") as mock_route:
            mock_route.return_value = (AgentIntent.SCREENING, skill_data)
            result = process_joule_query("screen the counterparty", {})

        self.assertIn("Do not clear", result["recommendation"])
        self.assertIn("adverse-media", result["recommendation"])
        sections = {section["label"]: section["content"] for section in result["sections"]}
        self.assertIn("Compliance Override", sections)
        self.assertIn("BENEFICIAL_OWNER_SANCTIONS_MATCH", sections["Compliance Override"])
        self.assertIn("Adverse media: not_checked", sections["Screening Coverage"])

    @patch("backend.orchestration_config.run_orchestrated_prompt")
    def test_case_override_forces_hold_and_escalate(self, mock_prompt):
        mock_prompt.return_value = """{
            "title": "Case File",
            "sections": [{"label": "Alert Details", "content": "High-priority alert."}],
            "recommendation": "Further investigation required.",
            "risk_factors": []
        }"""
        skill_data = {
            "skill": "assemble_and_draft_case_skill",
            "case_metadata": {},
            "related_alerts": [],
            "related_transactions": [],
            "assessment_context": {
                "overall_score": "100",
                "recommended_action": "HOLD_AND_ESCALATE",
                "policy_version": "2.1.0",
                "hard_overrides": [{
                    "ruleId": "BENEFICIAL_OWNER_SANCTIONS_MATCH",
                    "minimumScore": 100,
                }],
            },
        }

        with patch("joule_agent._route_skill") as mock_route:
            mock_route.return_value = (AgentIntent.DRAFT_CASE, skill_data)
            result = process_joule_query("assemble case file", {})

        self.assertIn("HOLD_AND_ESCALATE", result["recommendation"])
        sections = {section["label"]: section["content"] for section in result["sections"]}
        self.assertIn("Compliance Override", sections)
        self.assertIn("BENEFICIAL_OWNER_SANCTIONS_MATCH", sections["Compliance Override"])

if __name__ == "__main__":
    unittest.main()
