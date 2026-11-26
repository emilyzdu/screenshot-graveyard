"""Draft preparation for ONE screenshot: Make Notes (4A) and Add to Calendar (4B).

A thin, idempotent front door over the existing generation pipelines (Study
Note for ``make_notes``; Event Draft for ``add_calendar``). It adds only what
those pipelines lack for a per-screenshot "Prepare" action:

* lifecycle eligibility: the screenshot must be owned AND active (the Study
  Note selection policy does not look at archive state);
* a provider guard: preparation runs with the configured provider (``fake``
  or ``openai``; Batch 6A closed the consent check-to-dispatch race, tasks.md
  7.1). The worker refuses to run if the provider changed after acceptance, so
  a request accepted as simulated is never sent to a real provider;
* per-(screenshot, action) idempotency: a durable key on the existing
  ``operation.idempotency_key`` column, found-or-created under the workspace
  write lock, so repeated clicks, retries and concurrent requests reuse one
  operation and therefore one draft;
* a lookup of the latest preparation, so a reloaded page can find its draft.

A Make Notes draft is the existing ``study_note`` artifact, produced by the
unchanged ``StudyNoteService.run_generation`` worker. A calendar draft is an
``event_draft`` artifact produced by ``EventDraftService.run_generation``. Both
have their own id, version 1, origin and a source reference to the screenshot,
and both workers re-check consent and ownership before any bytes are read. No
external application (calendar or otherwise) is written to.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import config
from app.db.repository import WorkspaceRepository
from app.services.consent_service import ConsentService
from app.services.operation_service import OperationService, OperationState

ACTION_MAKE_NOTES = "make_notes"
ACTION_ADD_CALENDAR = "add_calendar"
# Each action has its own operation kind (and therefore its own artifact kind
# and worker). The idempotency key embeds the action, so two actions on one
# screenshot never share an operation or a draft.
OPERATION_KIND_BY_ACTION = {
    ACTION_MAKE_NOTES: "study_note",
    ACTION_ADD_CALENDAR: "event_draft",
}
SUPPORTED_ACTIONS = frozenset(OPERATION_KIND_BY_ACTION)
# Providers preparation may run with (Batch 6A: the consent-dispatch boundary
# in AIDispatchService now guards every adapter call).
PERMITTED_PROVIDERS = frozenset({"fake", "openai"})


class PreparationError(Exception):
    """Base class for preparation request errors."""


class PreparationNotFoundError(PreparationError):
    """Missing or foreign screenshot (identical, non-disclosing)."""


class PreparationNotActiveError(PreparationError):
    """The screenshot is archived."""


class PreparationUnsupportedActionError(PreparationError):
    """An action this version cannot prepare."""


class PreparationProviderBlockedError(PreparationError):
    """A real provider is configured: preparation fails closed."""


class PreparationUnavailableError(PreparationError):
    """Database unavailable."""


def key_prefix(screenshot_id: int, action: str) -> str:
    # Trailing colon: "screenshot:1:" can never prefix-match "screenshot:12:".
    return f"prepare:{action}:screenshot:{screenshot_id}:"


def idempotency_key(screenshot_id: int, action: str, provider: str) -> str:
    """The durable identity of one preparation request, provider included.

    The provider is part of the identity (a simulated draft is not the same
    request as a real-AI one) and is how a reloaded page learns, from the
    server, whether a draft is simulated, regardless of the provider mode at
    viewing time.
    """
    return f"{key_prefix(screenshot_id, action)}provider:{provider}"


def provider_from_key(key: str | None) -> str | None:
    if not key or ":provider:" not in key:
        return None
    return key.rsplit(":provider:", 1)[1] or None


def is_reusable(state: OperationState) -> bool:
    """Still running, or it produced a draft: never create a second one.

    A study_note operation that ended ``uncertain`` still persisted its draft
    (``artifact_id`` set), so it is reused too. Only a failure without a draft
    allows a new attempt.
    """
    return state.status == "pending" or state.artifact_id is not None


@dataclass(frozen=True)
class Preparation:
    screenshot_id: int
    action: str
    operation: OperationState
    provider: str | None
    reused: bool = False


class PreparationService:
    def __init__(self, session: Session, workspace_id: int) -> None:
        self._session = session
        self._workspace_id = workspace_id
        self._repo = WorkspaceRepository(session, workspace_id)
        self._operations = OperationService(session, workspace_id)
        self._consent = ConsentService(session, workspace_id)

    def _active_screenshot(self, screenshot_id: int):
        try:
            shot = self._repo.get_screenshot(screenshot_id)
        except SQLAlchemyError as exc:
            raise PreparationUnavailableError("preparation unavailable") from exc
        if shot is None:
            raise PreparationNotFoundError("not found")
        return shot

    def _require_active_locked(self, screenshot_id: int) -> None:
        # SQLAlchemyError propagates to create_or_reuse_keyed, which rolls back
        # and reports the operation service as unavailable.
        shot = self._repo.get_screenshot_locked(screenshot_id)
        if shot is None:
            raise PreparationNotFoundError("not found")
        if shot.state != "active":
            raise PreparationNotActiveError("archived")

    def request(self, screenshot_id: int, action: str) -> Preparation:
        """Start (or reuse) the preparation. Never calls an adapter itself.

        Order: action → provider guard → ownership → active → [locked: fresh
        ownership + active → reuse
        or (consent → quota → create)]. Consent and quota are checked only when
        a new operation would be created: returning an existing draft or a
        still-running preparation processes nothing.
        """
        if action not in SUPPORTED_ACTIONS:
            raise PreparationUnsupportedActionError(action)
        provider = config.AI_PROVIDER
        if provider not in PERMITTED_PROVIDERS:
            raise PreparationProviderBlockedError(provider)
        shot = self._active_screenshot(screenshot_id)
        if shot.state != "active":
            raise PreparationNotActiveError("archived")  # fast path; not authoritative
        state, reused = self._operations.create_or_reuse_keyed(
            OPERATION_KIND_BY_ACTION[action],
            idempotency_key(screenshot_id, action, provider),
            key_prefix=key_prefix(screenshot_id, action),
            reusable=is_reusable,
            # Authoritative: a fresh read under the workspace lock, before reuse
            # or creation. A Safe Burial committed after the fast-path read is
            # seen here, so nothing is created, counted or queued.
            after_lock=lambda: self._require_active_locked(screenshot_id),
            # Raises ConsentRequiredError inside the lock; nothing is written.
            before_create=lambda: self._consent.require_consent(screenshot_id),
        )
        return Preparation(screenshot_id, action, state, provider, reused)

    def latest(self, screenshot_id: int, action: str) -> Preparation | None:
        """The newest preparation for this screenshot and action, if any."""
        if action not in SUPPORTED_ACTIONS:
            raise PreparationUnsupportedActionError(action)
        self._active_screenshot(screenshot_id)  # ownership only; archived may still be read
        try:
            op = self._repo.latest_operation_with_key_prefix(key_prefix(screenshot_id, action))
        except SQLAlchemyError as exc:
            raise PreparationUnavailableError("preparation unavailable") from exc
        if op is None:
            return None
        state = OperationService._state(op)
        return Preparation(screenshot_id, action, state, provider_from_key(op.idempotency_key))
