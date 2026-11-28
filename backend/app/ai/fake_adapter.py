"""Deterministic, in-process AIAdapter test double (Task 2.2).

This adapter deliberately does not inspect image bytes, call a provider, read
credentials, or make network requests. It produces synthetic fixtures that make
later service tests deterministic while still exercising the same contract as a
real adapter.

``INVALID`` mode is intentional: it returns malformed provider-shaped data so
the service-level Pydantic validation gate (Task 2.5/2.7) can prove that invalid
provider output is never persisted. All other modes return schema-valid models.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from enum import Enum
from typing import cast

from app.ai.adapter import AIAdapterTimeoutError
from app.ai.schemas import (
    Category,
    ClassificationResult,
    EpitaphPayload,
    EventDraftResult,
    StudyNoteResult,
)


_FAKE_EVENT_NOTICE = (
    "Placeholder text from the Fake AI. It did not read your screenshot, so no "
    "date, time, time zone or location was extracted."
)


class FakeAIAdapterMode(str, Enum):
    """Explicit deterministic outcomes supported by :class:`FakeAIAdapter`."""

    NORMAL = "normal"
    INVALID = "invalid"
    TIMEOUT = "timeout"
    UNCERTAIN = "uncertain"


@dataclass(frozen=True)
class FakeAIAdapter:
    #: Batch 6A (P2-E): the provider recorded on every version this adapter writes.
    provider_id = "fake"
    """A deterministic, network-free adapter implementation for tests.

    The method annotations match :class:`app.ai.adapter.AIAdapter`. ``INVALID``
    mode is the sole deliberate runtime exception: it returns malformed raw
    provider output, cast only for the static Protocol contract, so callers can
    test their mandatory schema-validation failure path.
    """

    mode: FakeAIAdapterMode = FakeAIAdapterMode.NORMAL

    def classify_and_epitaph(
        self, image_bytes: bytes, mime: str, *, instructions: str | None = None
    ) -> ClassificationResult:
        """Return a synthetic classification without inspecting ``image_bytes``.

        Custom ``instructions`` (AI Redo) only change a clearly synthetic marker
        derived from a hash of the text; the text itself is never echoed and the
        fake never interprets the image or the guidance.
        """
        del image_bytes, mime
        self._raise_if_timeout()
        if self.mode is FakeAIAdapterMode.INVALID:
            return cast(
                ClassificationResult,
                {
                    "category": "not-a-real-category",
                    "confidence": 2.0,
                    "epitaph": {"text": "Malformed synthetic fixture"},
                },
            )
        if self.mode is FakeAIAdapterMode.UNCERTAIN:
            return ClassificationResult(
                category=Category.UNKNOWN_NEEDS_REVIEW,
                confidence=0.0,
                uncertain=True,
                epitaph=EpitaphPayload(
                    text="Purpose unknown (synthetic fixture).",
                    visible_facts="Synthetic adapter does not interpret image content.",
                    inferred_intent=None,
                    uncertain=True,
                ),
            )
        return ClassificationResult(
            category=Category.REFERENCE_DOCUMENT,
            confidence=0.75,
            uncertain=False,
            epitaph=EpitaphPayload(
                text=f"Synthetic reference fixture{self._marker(instructions)}.",
                visible_facts="Synthetic adapter does not interpret image content.",
                inferred_intent=None,
                uncertain=False,
            ),
        )

    def study_note(
        self,
        images: list[tuple[int, bytes, str]],
        *,
        instructions: str | None = None,
    ) -> StudyNoteResult:
        """Return a synthetic note whose references preserve supplied IDs."""
        self._raise_if_timeout()
        if self.mode is FakeAIAdapterMode.INVALID:
            return cast(
                StudyNoteResult,
                {
                    "topic": "",
                    "references": ["not-a-screenshot-id"],
                    "unexpected": "malformed synthetic fixture",
                },
            )

        references = [screenshot_id for screenshot_id, _bytes, _mime in images]
        if self.mode is FakeAIAdapterMode.UNCERTAIN:
            return StudyNoteResult(
                topic="Synthetic study note fixture",
                uncertain_content=[
                    "Synthetic adapter does not interpret image content."
                ],
                references=references,
            )
        return StudyNoteResult(
            topic="Synthetic study note fixture",
            main_concepts=["Deterministic test fixture"]
            + (
                [f"Synthetic regeneration fixture{self._marker(instructions)}"]
                if instructions
                else []
            ),
            uncertain_content=[],
            references=references,
        )

    def event_draft(self, images: list[tuple[int, bytes, str]]) -> EventDraftResult:
        """Return a clearly SIMULATED event draft that extracts nothing.

        The Fake never reads the image: no date, time, time zone or location is
        produced, and every one of them is listed as missing. Only the title is
        present, as an explicitly simulated placeholder marked uncertain.
        """
        self._raise_if_timeout()
        references = [screenshot_id for screenshot_id, _bytes, _mime in images]
        if self.mode is FakeAIAdapterMode.INVALID:
            return cast(
                EventDraftResult,
                {
                    "title": "Simulated event draft (Fake AI)",
                    "start_date": "tomorrow",
                    "references": ["not-a-screenshot-id"],
                    "unexpected": "malformed synthetic fixture",
                },
            )
        unknown = ["start_date", "start_time", "end_date", "end_time", "all_day", "time_zone", "location"]
        if self.mode is FakeAIAdapterMode.UNCERTAIN:
            return EventDraftResult(
                title=None,
                description=_FAKE_EVENT_NOTICE,
                missing_fields=["title", *unknown],
                references=references,
            )
        return EventDraftResult(
            title="Simulated event draft (Fake AI)",
            description=_FAKE_EVENT_NOTICE,
            missing_fields=unknown,
            uncertain_fields=["title"],
            references=references,
        )

    @staticmethod
    def _marker(instructions: str | None) -> str:
        """Deterministic, honest evidence that instructions were received."""
        if not instructions:
            return ""
        digest = hashlib.sha256(instructions.encode("utf-8")).hexdigest()[:8]
        return f" (custom instructions #{digest})"

    def _raise_if_timeout(self) -> None:
        if self.mode is FakeAIAdapterMode.TIMEOUT:
            # Do not sleep: deterministic tests simulate the observable timeout
            # outcome while real adapters enforce wall-clock deadlines.
            raise AIAdapterTimeoutError("simulated AI adapter timeout")
