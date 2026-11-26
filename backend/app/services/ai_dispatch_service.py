"""The consent-to-dispatch boundary for every AI adapter call (Batch 6A, tasks.md 7.1).

Implements design D of ``consent-dispatch-boundary-proposal.md`` in its
smallest form. Every worker that hands original bytes to an ``AIAdapter``
(Classification and its Redo, Study Notes / Make Notes and its Redo, Calendar
event drafts) calls :meth:`AIDispatchService.authorize` immediately before the
adapter call, and saves its result only through
:meth:`AIDispatchService.verify_for_persistence`.

Guarantee (SQLite and PostgreSQL alike):

* ``authorize`` is ONE short transaction under the workspace write lock
  (``lock_workspace``: SQLite's database write lock, PostgreSQL's
  ``SELECT ... FOR UPDATE`` on the workspace row). In it, the operation must
  still be pending and not yet dispatched, the consent of EVERY source is read
  fresh in one query and must be granted FOR THE CONFIGURED PROVIDER (a
  Fake-mode grant never authorizes a real provider), the heartbeat is
  recorded, and one
  ``ai_dispatch`` row per source is written with the consent version it was
  authorized against. Consent changes (``ConsentService.record_consent``) take
  the same lock, so a withdrawal and an authorization are totally ordered per
  workspace:

  - withdrawal commits first  -> ``authorize`` sees it and nothing is sent;
  - ``authorize`` commits first -> the request is treated as sent from that
    commit on. It cannot be recalled and may complete at the provider.

* ``verify_for_persistence`` runs inside the completion transaction, under the
  same lock. A result is saved only if every source is STILL granted at the
  SAME consent version. A withdrawal (or a withdraw-then-regrant) that happened
  while the request was out means the result is discarded and the operation
  fails with "AI processing consent required".

* No database transaction is open during the adapter call: ``authorize``
  commits before it returns.

* ``UNIQUE(operation_id, screenshot_id)`` plus the pending check mean a
  duplicate or retried worker for the same operation never dispatches twice.

What this cannot do: recall bytes already handed to the adapter, stop a
request already in flight, or control provider-side retention. The only
remaining gap is in-process code between the ``authorize`` commit and the
socket write (request building); a withdrawal in that gap is handled like any
in-flight request: the result is not saved.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.db import models
from app.db.repository import CrossWorkspaceError, WorkspaceRepository
from app import config
from app.services.consent_service import consent_is_effective
from app.services.operation_service import OperationGuardError

DISPATCHED = "dispatched"
COMPLETED = "completed"
DISCARDED = "discarded"
INTERRUPTED = "interrupted"  # stale recovery: may have been sent; result never saved


class DispatchDeniedError(Exception):
    """No dispatch: the operation must fail with ``detail`` (generic, safe)."""

    detail = "AI processing unavailable"


class DispatchConsentRequiredError(DispatchDeniedError):
    detail = "AI processing consent required"


class DispatchNotFoundError(DispatchDeniedError):
    detail = "Not found"


class DispatchUnavailableError(DispatchDeniedError):
    detail = "AI processing unavailable"


class DispatchSupersededError(Exception):
    """The operation is no longer pending, or it was already dispatched.

    The caller must NOT call the adapter and must NOT change the operation:
    another worker owns it (or it already ended).
    """


class DispatchConsentChangedError(OperationGuardError):
    """Consent changed while the request was out: the result is not saved."""

    def __init__(self) -> None:
        super().__init__("AI processing consent required")


@dataclass(frozen=True)
class DispatchTicket:
    operation_id: int
    screenshot_ids: tuple[int, ...]
    consent_versions: tuple[int, ...]


class AIDispatchService:
    def __init__(self, session: Session, workspace_id: int) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        self._session = session
        self._workspace_id = workspace_id
        self._repo = WorkspaceRepository(session, workspace_id)

    def _fresh_operation(self, operation_id: int) -> models.Operation | None:
        op = self._session.get(models.Operation, operation_id, populate_existing=True)
        if op is None or op.workspace_id != self._workspace_id:
            return None
        return op

    def authorize(
        self,
        operation_id: int,
        screenshot_ids: list[int],
        *,
        now: datetime | None = None,
        adapter_provider: str | None = None,
    ) -> DispatchTicket:
        """Authorize ONE adapter call for these sources, or raise. Commits before returning.

        ``adapter_provider`` is the adapter's own ``provider_id``. If it differs
        from the configured provider (whose disclosure the consent covers), the
        call is refused: data never goes to a provider the user was not told about.
        """
        if adapter_provider is not None and adapter_provider != config.AI_PROVIDER:
            raise DispatchUnavailableError()
        ids = list(screenshot_ids)
        if not ids or len(set(ids)) != len(ids) or any(type(i) is not int or i <= 0 for i in ids):
            raise DispatchNotFoundError()
        moment = now or datetime.now(timezone.utc)
        try:
            if self._repo.lock_workspace() is None:
                raise DispatchNotFoundError()
            op = self._fresh_operation(operation_id)
            if op is None:
                raise DispatchNotFoundError()
            if op.status != "pending" or self._repo.list_dispatches(op.id):
                raise DispatchSupersededError()
            consents = self._repo.get_consents_fresh(ids)
            versions: list[int] = []
            for sid in ids:
                record = consents[sid]
                if not consent_is_effective(record, config.AI_PROVIDER):
                    raise DispatchConsentRequiredError()
                versions.append(int(record.version or 0))
            op.updated_at = moment  # the heartbeat, inside the same transaction
            for sid, version in zip(ids, versions):
                self._repo.add_dispatch(operation_id=op.id, screenshot_id=sid, consent_version=version)
            self._session.commit()
        except (DispatchDeniedError, DispatchSupersededError):
            self._session.rollback()
            raise
        except CrossWorkspaceError as exc:
            self._session.rollback()
            raise DispatchNotFoundError() from exc
        except IntegrityError as exc:
            # A concurrent duplicate worker committed its dispatch first.
            self._session.rollback()
            raise DispatchSupersededError() from exc
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise DispatchUnavailableError() from exc
        return DispatchTicket(operation_id, tuple(ids), tuple(versions))

    def verify_for_persistence(self, ticket: DispatchTicket) -> None:
        """Call ONLY inside the completion transaction, after ``lock_workspace``.

        Raises :class:`DispatchConsentChangedError` unless every source is still
        granted at the version the dispatch was authorized against. Marks the
        dispatch rows ``completed`` (flushed; the caller commits).
        """
        rows = self._repo.list_dispatches(ticket.operation_id)
        if (
            tuple(r.screenshot_id for r in rows) != ticket.screenshot_ids
            or any(r.state != DISPATCHED for r in rows)
        ):
            raise DispatchConsentChangedError()
        try:
            consents = self._repo.get_consents_fresh(list(ticket.screenshot_ids))
        except CrossWorkspaceError as exc:
            raise DispatchConsentChangedError() from exc
        for sid, version in zip(ticket.screenshot_ids, ticket.consent_versions):
            record = consents[sid]
            if not consent_is_effective(record, config.AI_PROVIDER) or int(record.version or 0) != version:
                raise DispatchConsentChangedError()
        moment = datetime.now(timezone.utc)
        for r in rows:
            r.state = COMPLETED
            r.completed_at = moment
        self._session.flush()

    def discard(self, ticket: DispatchTicket) -> None:
        """Best effort: record that a dispatched request's result was not saved.

        Audit only. Never raises; a failure here changes no safety property
        (nothing unsaved is ever shown as saved).
        """
        try:
            if self._repo.lock_workspace() is None:
                self._session.rollback()
                return
            for r in self._repo.list_dispatches(ticket.operation_id):
                if r.state == DISPATCHED:
                    r.state = DISCARDED
                    r.completed_at = datetime.now(timezone.utc)
            self._session.commit()
        except SQLAlchemyError:
            self._session.rollback()
