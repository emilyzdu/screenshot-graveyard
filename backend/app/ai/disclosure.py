"""The server-defined AI processing disclosure (Batch 6A, P1-A).

A consent grant is bound to the exact disclosure the user was shown: the
browser reads it from ``GET /api/ai/disclosure`` and sends back its
``provider`` and ``revision`` with the grant. The server accepts a grant only
if both equal the CURRENTLY active disclosure, and records them; every AI
dispatch re-checks that the recorded pair still matches. So:

* a grant made while the Fake AI disclosure ("nothing is sent") was shown can
  never authorize an OpenAI call;
* a grant for an earlier OpenAI disclosure stops authorizing anything as soon
  as the disclosure text changes (the revision is derived from the text);
* the client cannot choose a provider: it can only echo what the server
  showed, and anything else is refused.

The text here is the single source of what the user is told; the frontend
displays it verbatim.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from app import config

DISCLOSURE_TEXT: dict[str, str] = {
    "fake": (
        "This development build uses the Fake AI adapter. Nothing is sent to an external AI provider, and the "
        "result is placeholder text that does not read your screenshot."
    ),
    "openai": (
        "Revive sends the original image of this screenshot to OpenAI to analyze it. The app asks OpenAI not to "
        "store the response, but OpenAI may keep request data for a limited time for abuse monitoring under its "
        "own policies. The result is an AI suggestion and can be wrong."
    ),
}


@dataclass(frozen=True)
class Disclosure:
    provider: str
    revision: str
    text: str

    def as_dict(self) -> dict:
        return {"provider": self.provider, "revision": self.revision, "text": self.text}


def disclosure_for(provider: str) -> Disclosure:
    """The disclosure for ``provider``; its revision changes whenever its text does."""
    text = DISCLOSURE_TEXT[provider]
    digest = hashlib.sha256(f"{provider}\n{text}".encode("utf-8")).hexdigest()[:16]
    return Disclosure(provider=provider, revision=f"{provider}-{digest}", text=text)


def current_disclosure() -> Disclosure:
    """The disclosure for the server's configured provider (never client-selected)."""
    return disclosure_for(config.AI_PROVIDER)


def revision_for(provider: str | None) -> str | None:
    if provider not in DISCLOSURE_TEXT:
        return None
    return disclosure_for(provider).revision
