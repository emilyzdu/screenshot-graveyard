"""Calendar event DRAFT generation for ONE screenshot (Batch 4B).

Executes one ``event_draft`` operation. It mirrors the reviewed Study Note
worker step for step, deliberately as a separate module so that worker is not
touched:

  pending + kind check -> consent -> read the original -> consent again
  -> heartbeat -> ONE adapter call -> strict re-validation -> references check
  -> atomic persistence of the ``event_draft`` artifact + version 1 + source
  reference + current-version pointer + operation status.

Contract:
  * Only a pending ``event_draft`` operation may execute; a repeated run never
    reaches consent, bytes or the adapter.
  * Consent is checked before any bytes are read and again immediately before
    the adapter call. Missing/revoked consent fails closed with no adapter call.
  * Adapter output is re-validated against ``EventDraftResult`` (a BaseModel
    instance is dumped and re-validated), so nothing unvalidated is stored.
  * ``references`` must equal ``[screenshot_id]`` exactly.
  * The operation ends ``uncertain`` whenever any field is missing or
    uncertain, otherwise ``successful``; both are committed with the draft.
  * Originals are only read (INV-1). Nothing is written to any external
    application: there is no calendar client anywhere in this path.
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel
from sqlalchemy.orm import Session

from app import config
from app.ai.adapter import AIAdapter, AIAdapterError
from app.ai.schemas import EventDraftResult
from app.db.repository import WorkspaceRepository
from app.services.artifact_version_service import ArtifactVersionService
from app.services.consent_service import (
    ConsentRequiredError,
    ConsentService,
    ConsentServiceUnavailableError,
    ScreenshotNotFoundError as ConsentScreenshotNotFoundError,
)
from app.services.operation_service import (
    OperationPersistenceError,
    OperationService,
    OperationState,
    OperationTransitionError,
)
from app.services.vault_service import VaultService, VaultServiceError
from app.services.vault_service import ScreenshotNotFoundError as VaultScreenshotNotFoundError

KIND_EVENT_DRAFT = "event_draft"
_ORIGIN_AI_GENERATE = "ai_generate"


@dataclass(frozen=True)
class EventDraftOutcome:
    operation: OperationState
    artifact_id: int | None = None


def event_draft_json(result: EventDraftResult) -> str:
    """The stored version payload: every field, unknown ones as null."""
    return result.model_dump_json()


class EventDraftService:
    def __init__(
        self,
        session: Session,
        workspace_id: int,
        *,
        adapter: AIAdapter,
        vault: VaultService | None = None,
    ) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        if adapter is None:
            raise ValueError("adapter is required")
        self._adapter = adapter
        self._consent = ConsentService(session, workspace_id)
        self._operations = OperationService(session, workspace_id)
        self._vault = vault or VaultService(session, workspace_id)
        self._repo = WorkspaceRepository(session, workspace_id)
        self._versions = ArtifactVersionService(session, workspace_id)

    def run_generation(self, screenshot_id: int, operation_id: int) -> EventDraftOutcome:
        """Execute one event_draft operation. Intended as the BackgroundTask body."""
        current = self._operations.get(operation_id)
        if current.kind != KIND_EVENT_DRAFT or current.status != "pending":
            return EventDraftOutcome(operation=current)

        failure = self._require_consent(screenshot_id, operation_id)
        if failure is not None:
            return failure
        try:
            original = self._vault.read_original(screenshot_id)
        except (VaultScreenshotNotFoundError, VaultServiceError):
            return self._fail(operation_id, "Not found")
        if original.byte_size > config.AI_MAX_INPUT_IMAGE_BYTES:
            return self._fail(operation_id, "AI input exceeds configured limits")
        images = [(screenshot_id, original.data, original.mime_type)]
        del original
        # Re-check immediately before the only adapter boundary.
        failure = self._require_consent(screenshot_id, operation_id)
        if failure is not None:
            images.clear()
            return failure
        try:
            self._operations.heartbeat_pending(operation_id)
        except OperationTransitionError:
            images.clear()
            return EventDraftOutcome(operation=self._operations.get(operation_id))

        try:
            raw = self._adapter.event_draft(images)  # EXACTLY ONE call
        except AIAdapterError:
            return self._fail(operation_id, "AI analysis failed")
        except Exception:
            return self._fail(operation_id, "AI analysis failed")
        finally:
            images.clear()
        try:
            payload = raw.model_dump() if isinstance(raw, BaseModel) else raw
            result = EventDraftResult.model_validate(payload)
        except Exception:
            return self._fail(operation_id, "AI output failed validation")
        if result.references != [screenshot_id]:
            return self._fail(operation_id, "AI output references invalid")

        uncertain = bool(result.missing_fields or result.uncertain_fields)
        created: dict[str, int] = {}

        def _persist() -> int:
            art = self._repo.create_artifact(kind=KIND_EVENT_DRAFT)
            self._versions.create_first_version(art.id, event_draft_json(result), _ORIGIN_AI_GENERATE)
            self._repo.add_source_reference(artifact_id=art.id, screenshot_id=screenshot_id)
            created["artifact_id"] = art.id
            return art.id

        try:
            op = self._operations.complete_after_persistence(
                operation_id, _persist, terminal_status="uncertain" if uncertain else "successful"
            )
        except (OperationPersistenceError, OperationTransitionError):
            return EventDraftOutcome(operation=self._operations.get(operation_id))
        return EventDraftOutcome(operation=op, artifact_id=created.get("artifact_id"))

    def _require_consent(self, screenshot_id: int, operation_id: int) -> EventDraftOutcome | None:
        try:
            self._consent.require_consent(screenshot_id)
        except ConsentRequiredError:
            return self._fail(operation_id, "AI processing consent required")
        except ConsentScreenshotNotFoundError:
            return self._fail(operation_id, "Not found")
        except ConsentServiceUnavailableError:
            return self._fail(operation_id, "AI processing unavailable")
        return None

    def _fail(self, operation_id: int, detail: str) -> EventDraftOutcome:
        try:
            op = self._operations.set_terminal_status(operation_id, "failed", error_detail=detail)
        except OperationTransitionError:
            op = self._operations.get(operation_id)
        return EventDraftOutcome(operation=op)
