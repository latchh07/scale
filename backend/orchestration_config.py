"""
backend/orchestration_config.py
================================
SAP AI Core Orchestration pipeline with:
  - Data Masking   : SAP Data Privacy Integration (PSEUDONYMIZATION)
                     Entities: PERSON, EMAIL, PHONE, ADDRESS, IBAN, CREDIT_CARD_NUMBER
  - Content Filter : Azure Content Safety on input + output
                     (Violence, Hate, Self-Harm → ALLOW_SAFE threshold)
  - LLM Module     : gpt-4o via orchestration deployment

Public API
----------
  get_orchestration_config(system_instruction, user_prompt) -> OrchestrationConfig
  run_orchestrated_prompt(system_instruction, user_prompt)  -> str
  get_proxy_client()                                        -> GenAIHubProxyClient

Run directly for a smoke test:
  python backend/orchestration_config.py
"""

from __future__ import annotations

import os
import sys
from typing import Optional

from dotenv import load_dotenv

# Force UTF-8 output on Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# 1. Environment
# ---------------------------------------------------------------------------

_ENV_PATH = os.path.join(os.path.dirname(__file__), "..", "team_12.env")
load_dotenv(dotenv_path=_ENV_PATH)

_AICORE_CLIENT_ID      = os.getenv("AICORE_CLIENT_ID")
_AICORE_CLIENT_SECRET  = os.getenv("AICORE_CLIENT_SECRET")
_AICORE_AUTH_URL       = os.getenv("AICORE_AUTH_URL", "")
_AICORE_API_URL        = os.getenv("AICORE_API_URL", "")
_AICORE_RESOURCE_GROUP = os.getenv("AICORE_RESOURCE_GROUP", "team-12")

# Confirmed-running orchestration deployment (see check_hana_features.py output)
_ORCH_DEPLOY_URL = (
    "https://api.ai.prod-ap11.ap-southeast-1.aws.ml.hana.ondemand.com"
    "/v2/inference/deployments/d6405ae8bcff77e3"
)

# ---------------------------------------------------------------------------
# 2. Proxy client factory
# ---------------------------------------------------------------------------

def build_proxy_client():
    """
    Build and return a GenAIHubProxyClient using AI Core credentials from env.
    The client is used to authenticate orchestration requests.
    """
    from gen_ai_hub.proxy.core.proxy_clients import get_proxy_client

    return get_proxy_client(
        proxy_client_name="gen-ai-hub",
        base_url=_AICORE_API_URL,
        auth_url=_AICORE_AUTH_URL.rstrip("/") + "/oauth/token",
        client_id=_AICORE_CLIENT_ID,
        client_secret=_AICORE_CLIENT_SECRET,
        resource_group=_AICORE_RESOURCE_GROUP,
    )


# ---------------------------------------------------------------------------
# 3. Module configurations
# ---------------------------------------------------------------------------

def _build_llm(
    model: str = "gpt-4o",
    temperature: float = 0.3,
    max_tokens: int = 1024,
):
    """Return an LLM module config for the orchestration pipeline."""
    from gen_ai_hub.orchestration.models.llm import LLM

    return LLM(
        name=model,
        parameters={
            "temperature": temperature,
            "max_tokens": max_tokens,
        },
    )


def _build_data_masking():
    """
    Return a DataMasking module using SAP Data Privacy Integration.

    Method     : PSEUDONYMIZATION  (replaces PII with consistent placeholders,
                 e.g. <PERSON_1>, so the LLM can still reason about relationships)
    Entities   : PERSON, EMAIL, PHONE, ADDRESS, IBAN, CREDIT_CARD_NUMBER
                 — all relevant for financial AML/compliance use cases.
    """
    from gen_ai_hub.orchestration.models.data_masking import DataMasking
    from gen_ai_hub.orchestration.models.sap_data_privacy_integration import (
        MaskingMethod,
        ProfileEntity,
        SAPDataPrivacyIntegration,
    )

    provider = SAPDataPrivacyIntegration(
        method=MaskingMethod.PSEUDONYMIZATION,
        entities=[
            ProfileEntity.PERSON,
            ProfileEntity.EMAIL,
            ProfileEntity.PHONE,
            ProfileEntity.ADDRESS,
            ProfileEntity.IBAN,
            ProfileEntity.CREDIT_CARD_NUMBER,
        ],
    )
    return DataMasking(providers=[provider])


def _build_content_filtering():
    """
    Return a ContentFiltering module using Azure Content Safety.

    Thresholds (applied identically on input and output):
      Violence  → ALLOW_SAFE   (block low+)
      Hate      → ALLOW_SAFE   (block low+)
      Self-Harm → ALLOW_SAFE   (block low+)
      Sexual    → ALLOW_SAFE   (block low+)

    AzureThreshold values:
      ALLOW_SAFE            = 0  (strictest — safe content only)
      ALLOW_SAFE_LOW        = 2
      ALLOW_SAFE_LOW_MEDIUM = 4
      ALLOW_ALL             = 6  (most permissive)
    """
    from gen_ai_hub.orchestration.models.azure_content_filter import (
        AzureContentFilter,
        AzureThreshold,
    )
    from gen_ai_hub.orchestration.models.content_filtering import (
        ContentFiltering,
        InputFiltering,
        OutputFiltering,
    )

    azure_filter = AzureContentFilter(
        hate=AzureThreshold.ALLOW_SAFE,
        sexual=AzureThreshold.ALLOW_SAFE,
        violence=AzureThreshold.ALLOW_SAFE,
        self_harm=AzureThreshold.ALLOW_SAFE,
    )

    return ContentFiltering(
        input_filtering=InputFiltering(filters=[azure_filter]),
        output_filtering=OutputFiltering(filters=[azure_filter]),
    )


def _build_template(system_instruction: str, user_prompt: str):
    """Return a Template with a fixed system message and a single user message."""
    from gen_ai_hub.orchestration.models.message import SystemMessage, UserMessage
    from gen_ai_hub.orchestration.models.template import Template

    return Template(
        messages=[
            SystemMessage(system_instruction),
            UserMessage(user_prompt),
        ]
    )


# ---------------------------------------------------------------------------
# 4. Orchestration config factory
# ---------------------------------------------------------------------------

def get_orchestration_config(
    system_instruction: str,
    user_prompt: str,
    model: str = "gpt-4o",
    temperature: float = 0.3,
    max_tokens: int = 1024,
    enable_masking: bool = True,
    enable_filtering: bool = True,
) -> "OrchestrationConfig":
    """
    Build a fully configured OrchestrationConfig combining:
      - LLM module      (gpt-4o, configurable temperature / max_tokens)
      - Data masking    (SAP DPI pseudonymization for PII entities)
      - Content filter  (Azure Content Safety, ALLOW_SAFE on all categories)

    Parameters
    ----------
    system_instruction : System prompt context for the LLM
    user_prompt        : The user's input message
    model              : LLM model name (default: gpt-4o)
    temperature        : Sampling temperature (default: 0.3 for consistent output)
    max_tokens         : Max tokens in response (default: 1024)
    enable_masking     : Toggle data masking (default: True)
    enable_filtering   : Toggle content filtering (default: True)

    Returns
    -------
    OrchestrationConfig ready to pass to OrchestrationService.run()
    """
    from gen_ai_hub.orchestration.models.config import OrchestrationConfig

    return OrchestrationConfig(
        template=_build_template(system_instruction, user_prompt),
        llm=_build_llm(model=model, temperature=temperature, max_tokens=max_tokens),
        data_masking=_build_data_masking() if enable_masking else None,
        filtering=_build_content_filtering() if enable_filtering else None,
    )


# ---------------------------------------------------------------------------
# 5. Main orchestration helper
# ---------------------------------------------------------------------------

def run_orchestrated_prompt(
    system_instruction: str,
    user_prompt: str,
    model: str = "gpt-4o",
    temperature: float = 0.3,
    max_tokens: int = 1024,
    enable_masking: bool = True,
    enable_filtering: bool = True,
) -> str:
    """
    Run a prompt through the full SAP AI Core orchestration pipeline:
      PII masking → content filter (input) → gpt-4o → content filter (output)

    Parameters
    ----------
    system_instruction : System prompt / role context
    user_prompt        : Raw user input (may contain PII — will be masked)
    model              : LLM model (default: gpt-4o)
    temperature        : LLM temperature (default: 0.3)
    max_tokens         : Max response tokens (default: 1024)
    enable_masking     : Toggle data masking module (default: True)
    enable_filtering   : Toggle content filtering module (default: True)

    Returns
    -------
    The LLM's sanitized text response as a plain string.

    Raises
    ------
    RuntimeError  if the content filter blocks the request
    Exception     for any other orchestration failure
    """
    from gen_ai_hub.orchestration.service import OrchestrationService
    from gen_ai_hub.orchestration.exceptions import OrchestrationError

    proxy = build_proxy_client()
    config = get_orchestration_config(
        system_instruction=system_instruction,
        user_prompt=user_prompt,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        enable_masking=enable_masking,
        enable_filtering=enable_filtering,
    )

    svc = OrchestrationService(
        api_url=_ORCH_DEPLOY_URL,
        config=config,
        proxy_client=proxy,
    )

    try:
        response = svc.run()
        return response.orchestration_result.choices[0].message.content

    except OrchestrationError as exc:
        # Surface content policy violations cleanly
        raise RuntimeError(
            f"Orchestration blocked by safety policy: {exc}"
        ) from exc

    except Exception as exc:
        err_str = str(exc)
        # Check for content filter refusal in error body
        if "content_filter" in err_str.lower() or "policy" in err_str.lower():
            raise RuntimeError(
                f"Content filter violation detected: {err_str}"
            ) from exc
        raise


# ---------------------------------------------------------------------------
# 6. Smoke test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 65)
    print("  backend/orchestration_config.py  --  Smoke Test")
    print("=" * 65)

    SYSTEM = (
        "You are a financial compliance analyst. "
        "Summarize the transaction event described and flag any AML concerns. "
        "Be concise — respond in 3 sentences or fewer."
    )

    test_cases = [
        {
            "label": "Test 1 — PII masking + normal content",
            "prompt": (
                "John Doe at john.doe@example.com transferred $50,000 "
                "to an account held by Jane Smith (IBAN: GB29 NWBK 6016 1331 9268 19, "
                "phone: +1-555-867-5309). Flag this transaction for review."
            ),
        },
        {
            "label": "Test 2 — Financial narrative without PII",
            "prompt": (
                "A company made 12 rapid wire transfers of $9,800 each to different "
                "offshore accounts within 48 hours. Each transfer was just below the "
                "$10,000 reporting threshold. Analyze the AML risk."
            ),
        },
        {
            "label": "Test 3 — Masking disabled, filtering enabled",
            "prompt": "Summarize the risk profile of a high-frequency trader in one sentence.",
            "extra_kwargs": {"enable_masking": False},
        },
    ]

    for tc in test_cases:
        print(f"\n{'-' * 65}")
        print(f"  {tc['label']}")
        print(f"{'-' * 65}")
        print(f"  Prompt : {tc['prompt'][:120]}...")
        print()

        try:
            kwargs = tc.get("extra_kwargs", {})
            response = run_orchestrated_prompt(
                system_instruction=SYSTEM,
                user_prompt=tc["prompt"],
                **kwargs,
            )
            print(f"  Response:")
            # Wrap at 60 chars for readability
            for line in response.split("\n"):
                print(f"    {line}")
            print()
            print("  [OK]")

        except RuntimeError as exc:
            print(f"  [BLOCKED] {exc}")
        except Exception as exc:
            print(f"  [ERROR]   {exc}")

    print()
    print("=" * 65)
    print("  Smoke test complete.")
    print("=" * 65)
