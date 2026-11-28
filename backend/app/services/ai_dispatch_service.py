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


class DispatchArchivedError(DispatchDeniedError):
    detail = "Screenshot archived"


class DispatchAutomationOffError(DispatchDeniedError):
    detail = "Automatic processing was turned off"


class DispatchRouteChangedError(DispatchDeniedError):
    detail = "The automatic step no longer applies"


class DispatchResultSupersededError(OperationGuardError):
    """Batch 6B: the result came back after something it depended on changed
    (a newer analysis version, or the automatic step no longer applies). It is
    not saved; the operation fails with this detail."""

    def __init__(self, why: str = "the analysis changed while the AI was working") -> None:
        super().__init__(f"Superseded: {why}")


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
    # Batch 6B: the analysis this request was authorized against (classification
    # and Epitaph: (artifact id, current version id) or None each), captured
    # under the dispatch lock. None = not checked for this request.
    analysis_versions: tuple | None = None
    # Batch 6B: the operation key, so the stop policy can be re-checked when the
    # result returns ("authorized to start" is not "authorized to publish").
    policy_key: str | None = None


def _is_auto_prepare(key: str) -> bool:
    return key.startswith("prepare:") and ":auto:provider:" in key


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
        snapshot_analysis: bool = False,
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
            self._check_policy(op.idempotency_key or "", ids)  # Batch 6B: stop actions, under the same lock
            key = op.idempotency_key or ""
            # Batch 6B: remember which analysis this request was authorized
            # against, for analysis writers (classification, Redo) and for
            # automatic preparations, which were routed from it.
            snapshot = (
                self._analysis_versions(ids[0])
                if len(ids) == 1 and (snapshot_analysis or _is_auto_prepare(key))
                else None
            )
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
        return DispatchTicket(operation_id, tuple(ids), tuple(versions), snapshot, key or None)

    def _analysis_versions(self, screenshot_id: int) -> tuple:
        """(artifact id, current version id) of the newest classification and
        Epitaph, or None for each that does not exist. Fresh read; call under
        the workspace lock."""
        self._session.expire_all()  # never compare against objects loaded before the lock
        out = []
        for kind in ("classification", "epitaph"):
            arts = self._repo.list_artifacts_for_screenshot(screenshot_id, kind)
            out.append((arts[-1].id, arts[-1].current_version_id) if arts else None)
        return tuple(out)

    def _check_policy(self, key: str, ids: list[int]) -> None:
        """Batch 6B: what else must still hold at the moment of dispatch.

        Runs inside ``authorize``'s locked transaction, after the consent check
        and before the dispatch is recorded, so archiving, turning automation
        off, editing the analysis and choosing another step (all of which take
        the same workspace lock) are each ordered strictly before or after it.
        Applies only to the screenshot-scoped requests (keyed ``classify:`` and
        ``prepare:`` operations); Redo and multi-screenshot Study Notes are
        unchanged.

        * every such request: the screenshot must still be active;
        * a request started by automatic processing (``:auto:`` in its key):
          automation must still be on, and an automatic preparation must still
          be the canonical router's choice for the CURRENT saved analysis, with
          no draft for another action started meanwhile (the user's choice wins).
        Manual requests never depend on the automation preference.
        """
        if not (key.startswith("classify:screenshot:") or key.startswith("prepare:")) or len(ids) != 1:
            return
        sid = ids[0]
        shot = self._repo.get_screenshot_locked(sid)
        if shot is None:
            raise DispatchNotFoundError()
        if shot.state != "active":
            raise DispatchArchivedError()
        if ":auto:provider:" not in key:
            return
        if not self._repo.get_auto_prepare():
            raise DispatchAutomationOffError()
        if key.startswith("prepare:"):
            # Local imports: these services sit above the dispatch boundary.
            from app.services.auto_process_service import auto_route_now
            from app.services.preparation_service import SUPPORTED_ACTIONS, key_prefix

            action = key.split(":", 2)[1]
            if auto_route_now(self._session, self._workspace_id, sid) != action:
                raise DispatchRouteChangedError()
            for other in SUPPORTED_ACTIONS - {action}:
                if self._repo.latest_operation_with_key_prefix(key_prefix(sid, other)) is not None:
                    raise DispatchRouteChangedError()

    def verify_for_persistence(self, ticket: DispatchTicket) -> None:
        """Call ONLY inside the completion transaction, after ``lock_workspace``.

        Raises :class:`DispatchConsentChangedError` unless every source is still
        granted at the version the dispatch was authorized against. Marks the
        dispatch rows ``completed`` (flushed; the caller commits).

        Batch 6B: a result is also refused (:class:`DispatchResultSupersededError`)
        if the analysis it was authorized against has a newer version now (a
        user edit or another AI result landed while it was out), or, for a
        request started by automation, if the automatic step no longer applies
        (archived, automation off, a different route, another draft chosen).
        Manual drafts are never superseded by analysis edits: they are the
        user's own request, not a decision derived from the analysis.
        """
        if ticket.analysis_versions is not None and len(ticket.screenshot_ids) == 1:
            if self._analysis_versions(ticket.screenshot_ids[0]) != ticket.analysis_versions:
                raise DispatchResultSupersededError()
        # The automatic-step policy governs automatic DRAFTS. An automatic
        # analysis is consented and harmless to save (nothing follows from it
        # once automation is off), so only the analysis snapshot applies to it.
        if ticket.policy_key and _is_auto_prepare(ticket.policy_key):
            try:
                self._check_policy(ticket.policy_key, list(ticket.screenshot_ids))
            except DispatchDeniedError as exc:
                raise DispatchResultSupersededError(exc.detail[0].lower() + exc.detail[1:]) from exc
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
