"""Make Notes draft preparation for ONE screenshot (Batch 4A).

A thin, idempotent front door over the existing Study Note pipeline. It adds
only what that pipeline lacks for a per-screenshot "Prepare" action:

* lifecycle eligibility: the screenshot must be owned AND active (the Study
  Note selection policy does not look at archive state);
* a real-provider fail-closed guard: preparation runs only while the
  configured provider is the deterministic fake, because the consent
  check-to-dispatch race (tasks.md 7.1) is still open;
* per-(screenshot, action) idempotency: a durable key on the existing
  ``operation.idempotency_key`` column, found-or-created under the workspace
  write lock, so repeated clicks, retries and concurrent requests reuse one
  operation and therefore one draft;
* a lookup of the latest preparation, so a reloaded page can find its draft.

The draft itself is the existing ``study_note`` artifact (own id, version 1,
origin, source reference to the screenshot), produced by the unchanged
``StudyNoteService.run_generation`` worker, which re-checks consent and
ownership before any bytes are read. No external application is written to.
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
SUPPORTED_ACTIONS = frozenset({ACTION_MAKE_NOTES})
# The only provider preparation may run with until the consent-dispatch fix ships.
PERMITTED_PROVIDERS = frozenset({"fake"})
_KIND = "study_note"


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
            _KIND,
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
