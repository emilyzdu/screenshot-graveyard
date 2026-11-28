"""Test helpers for disclosure-bound consent (Batch 6A, P1-A).

Evaluated at call time, so a test that switches ``config.AI_PROVIDER`` grants
against the disclosure that is active at that moment (as a browser that just
read ``GET /api/ai/disclosure`` would).
"""

from __future__ import annotations

from app.ai.disclosure import current_disclosure


def grant_body() -> dict:
    d = current_disclosure()
    return {"granted": True, "provider": d.provider, "disclosureRevision": d.revision}


__all__ = ["current_disclosure", "grant_body"]
