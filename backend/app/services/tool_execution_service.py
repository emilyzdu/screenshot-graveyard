"""Human-authorized execution of ONE approved planned action (the only external write).

Nothing here runs because a model asked for it. Two steps, both server-checked:

**Authorize (the user's Run request) -> ``reserved``.** External tools
enabled (and for real accounts ``COMPOSIO_ALLOW_LIVE_WRITES=1``); the CURRENT
plan version; an approval of exactly that version whose SHA-256 matches the
stored bytes AND the hash the request names; the action enabled, complete and
bound to the workspace's current active connection (re-confirmed with the
provider); arguments rebuilt server-side; and no conflicting execution for
the same delivery identity (see below). A ``reserved`` row is provably NOT
sent.

**Dispatch (background) -> linearization point.** The provider re-confirms
the account (owner, toolkit, ACTIVE), with no lock held. Then, in ONE
transaction under the workspace write lock, everything that a stop operation
can change is re-read fresh: the reservation is still ``reserved``, the
screenshot is active, the approved version is still current, the approval
and its hash, the plan's binding, the connection (current, active, same
account), and the rebuilt arguments hash. Disconnect, Safe Burial and plan
revisions take the same lock (Safe Burial's screenshot row on PostgreSQL), so
each is ordered strictly before or after this decision:

* a stop that commits first -> the reservation becomes ``cancelled``
  (never sent; a new Run is allowed);
* otherwise the row becomes ``executing`` (conditional ``UPDATE ... WHERE
  status='reserved'``) and commits. THAT COMMIT IS THE LINEARIZATION POINT:
  from then on the write is treated as possibly sent, and a later stop cannot
  cancel it. The provider call follows, exactly once, never retried.

Outcomes, each written with ``UPDATE ... WHERE status='executing'`` so a
settled row is never overwritten: ``succeeded`` (Calendar: the returned
event carries our delivery marker; Notion/Gmail: an item id, recorded as an
UNVERIFIED receipt), ``rejected`` (the app or gateway answered with an
error; not proof nothing happened, never retried), ``unknown`` (no reliable
answer, never retried), ``failed`` (no connection could be opened, so
nothing was sent). An ``executing`` row past the stale window becomes
``unknown``; a ``reserved`` one becomes ``cancelled``.

Delivery identity (``app.tools.arguments``): ``scope_key`` = (workspace,
screenshot, tool, destination toolkit); ``delivery_key`` = scope + normalized
intended action. Under the lock, and structurally through partial unique
indexes: at most one unresolved (reserved / executing / unknown) execution
per scope, and at most one held (also succeeded / rejected) execution per
delivery identity. Neither depends on a plan artifact, so replanning or
revising cannot bypass them; a genuinely different intended action in the
same scope may run once nothing in that scope is unresolved.

A plan, its versions, its approval and the screenshot are never changed by
any of this (INV-4).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select, update
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app import config
from app.db import models
from app.db.repository import CrossWorkspaceError, WorkspaceRepository
from app.db.tool_repository import ToolRepository
from app.services.action_plan_service import (
    ActionPlanNotFoundError,
    ActionPlanService,
    ActionPlanUnavailableError,
    find_action,
)
from app.services.draft_versioning import DraftSourceArchivedError, DraftSourceMissingError, require_sources_active
from app.services.tool_connection_service import (
    ConnectionNotActiveError,
    ConnectionUnavailableError,
    ToolConnectionService,
    ToolsDisabledError,
)
from app.tools.arguments import (
    ArgumentError,
    ReceiptError,
    arguments_sha256,
    build_arguments,
    delivery_key,
    extract_receipt,
    scope_key,
)
from app.tools.catalog import CATALOG
from app.tools.provider import get_tool_transport
from app.tools.transport import (
    ToolNotSentError,
    ToolOutcomeUnknownError,
    ToolRejectedError,
    ToolTransport,
)

RESERVED, EXECUTING, CANCELLED = "reserved", "executing", "cancelled"
SUCCEEDED, FAILED, REJECTED, UNKNOWN = "succeeded", "failed", "rejected", "unknown"
UNRESOLVED = frozenset(models.EXECUTION_UNRESOLVED)
HELD = frozenset(models.EXECUTION_DELIVERY_HELD)

_DETAIL = {
    FAILED: "Not sent: the connection to the app could not be opened. You can try again.",
    REJECTED: "The app answered with an error. That does not prove nothing was created; check your account. It will not be retried automatically.",
    UNKNOWN: "No reliable answer from the app (an error reply is not proof nothing happened). The item may or may not exist; check your account. It will not be retried automatically.",
    "unverified": "The app returned an item id, but it could not be matched to this request.",
}


class ExecutionError(Exception):
    code = "execution_refused"
    message = "This action cannot run"


class ExecutionDisabledError(ExecutionError):
    code, message = "tools_disabled", "External apps are not enabled"


class LiveWritesDisabledError(ExecutionError):
    code, message = "live_writes_disabled", "Writing to real accounts is not enabled on this server"


class ExecutionNotFoundError(ExecutionError):
    code, message = "not_found", "Not Found"


class ExecutionNotApprovedError(ExecutionError):
    code, message = "not_approved", "Approve this exact version before running it"


class ExecutionStaleVersionError(ExecutionError):
    code, message = "version_conflict", "The plan changed since you reviewed it"


class ExecutionIncompleteError(ExecutionError):
    code, message = "action_not_ready", "This action is incomplete or turned off"


class ExecutionReconnectError(ExecutionError):
    code, message = "reconnect_required", "Reconnect the app, save the plan again and approve it"


class ExecutionArchivedError(ExecutionError):
    code, message = "screenshot_archived", "Resurrect the screenshot before running its plan"


class ExecutionDuplicateError(ExecutionError):
    code, message = "already_executed", "This action already ran, is running, or has an unresolved outcome"

    def __init__(self, existing: "ExecutionView | None") -> None:
        super().__init__(self.message)
        self.existing = existing


class ExecutionUnavailableError(ExecutionError):
    code, message = "service_unavailable", "Service temporarily unavailable"


@dataclass(frozen=True)
class ExecutionView:
    execution_id: int
    artifact_id: int
    version_id: int
    action_index: int
    attempt: int
    tool: str
    toolkit: str
    toolkit_version: str
    status: str
    simulated: bool
    external_id: str | None
    external_url: str | None
    receipt_verified: bool | None
    detail: str | None
    created_at: str
    completed_at: str | None


@dataclass(frozen=True)
class Reservation:
    execution_id: int
    arguments: dict


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat() if dt.tzinfo else dt.isoformat() + "+00:00"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _view(row: models.ToolExecution) -> ExecutionView:
    ok = row.status == SUCCEEDED
    return ExecutionView(
        execution_id=row.id, artifact_id=row.artifact_id, version_id=row.artifact_version_id,
        action_index=row.action_index, attempt=row.attempt, tool=row.tool_slug, toolkit=row.toolkit,
        toolkit_version=row.toolkit_version, status=row.status, simulated=row.mode == "fake",
        external_id=row.external_id if ok else None, external_url=row.external_url if ok else None,
        receipt_verified=row.receipt_verified if ok else None,
        detail=row.error_detail, created_at=_iso(row.created_at), completed_at=_iso(row.completed_at),
    )


def content_sha256(content_json: str) -> str:
    return hashlib.sha256(content_json.encode("utf-8")).hexdigest()


class ToolExecutionService:
    def __init__(self, session: Session, workspace_id: int, *, transport: ToolTransport | None = None) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        self._session = session
        self._workspace_id = workspace_id
        self._repo = WorkspaceRepository(session, workspace_id)
        self._tools = ToolRepository(session, workspace_id)
        self._transport = transport if transport is not None else get_tool_transport()
        self._plans = ActionPlanService(session, workspace_id, transport=self._transport)
        self._connections = ToolConnectionService(session, workspace_id, transport=self._transport)

    # --------------------------------------------------------- conditional writes
    def _transition(self, execution_id: int, from_status: str, **values) -> bool:
        """``UPDATE ... WHERE id = ? AND status = from_status``. Never trusts cached ORM state."""
        values.setdefault("updated_at", _now())
        result = self._session.execute(
            update(models.ToolExecution)
            .where(
                models.ToolExecution.id == execution_id,
                models.ToolExecution.workspace_id == self._workspace_id,
                models.ToolExecution.status == from_status,
            )
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        return result.rowcount == 1

    def _fresh(self, execution_id: int) -> models.ToolExecution | None:
        return self._session.scalars(
            select(models.ToolExecution)
            .where(models.ToolExecution.id == execution_id, models.ToolExecution.workspace_id == self._workspace_id)
            .execution_options(populate_existing=True)
        ).one_or_none()

    def _settle_overdue_locked(self) -> None:
        """Under the lock: overdue ``executing`` -> unknown; overdue ``reserved`` -> cancelled.

        Conditional UPDATEs on the database's current state: a row settled by
        another worker (e.g. ``succeeded``) no longer matches and is untouched.
        """
        now = _now()
        cutoff = now - timedelta(seconds=config.TOOL_EXECUTION_STALE_SECONDS)
        base = (models.ToolExecution.workspace_id == self._workspace_id,)
        self._session.execute(
            update(models.ToolExecution)
            .where(*base, models.ToolExecution.status == EXECUTING, models.ToolExecution.dispatched_at < cutoff)
            .values(status=UNKNOWN, error_detail=_DETAIL[UNKNOWN], completed_at=now, updated_at=now)
            .execution_options(synchronize_session=False)
        )
        self._session.execute(
            update(models.ToolExecution)
            .where(*base, models.ToolExecution.status == RESERVED, models.ToolExecution.created_at < cutoff)
            .values(status=CANCELLED, error_detail="Cancelled before sending: it was never dispatched.",
                    completed_at=now, updated_at=now)
            .execution_options(synchronize_session=False)
        )

    def _settle_stale(self, artifact_id: int | None = None) -> None:
        """Settle overdue rows of this workspace (``artifact_id`` kept for callers; scope is the workspace)."""
        cutoff = _now() - timedelta(seconds=config.TOOL_EXECUTION_STALE_SECONDS)
        overdue = self._session.scalar(
            select(models.ToolExecution.id).where(
                models.ToolExecution.workspace_id == self._workspace_id,
                or_(
                    (models.ToolExecution.status == EXECUTING) & (models.ToolExecution.dispatched_at < cutoff),
                    (models.ToolExecution.status == RESERVED) & (models.ToolExecution.created_at < cutoff),
                ),
            ).limit(1)
        )
        if overdue is None:
            self._session.rollback()
            return
        if self._repo.lock_workspace() is None:
            self._session.rollback()
            return
        self._settle_overdue_locked()
        self._session.commit()
        self._session.expire_all()

    # ------------------------------------------------------------------ reads
    def list_for_plan(self, artifact_id: int) -> list[ExecutionView]:
        try:
            self._plans.get_version(artifact_id)  # ownership + kind
            self._settle_stale(artifact_id)
            return [_view(r) for r in self._tools.list_executions(artifact_id)]
        except ActionPlanNotFoundError as exc:
            raise ExecutionNotFoundError() from exc
        except (ActionPlanUnavailableError, SQLAlchemyError) as exc:
            self._session.rollback()
            raise ExecutionUnavailableError() from exc

    def history_for_scopes(self, scopes: list[str]) -> dict[str, list[ExecutionView]]:
        """Executions sharing a delivery scope, from ANY plan of this workspace (replans included)."""
        if not scopes:
            return {}
        rows = self._session.scalars(
            select(models.ToolExecution)
            .where(models.ToolExecution.workspace_id == self._workspace_id, models.ToolExecution.scope_key.in_(scopes))
            .order_by(models.ToolExecution.id)
            .execution_options(populate_existing=True)
        )
        out: dict[str, list[ExecutionView]] = {s: [] for s in scopes}
        for r in rows:
            out[r.scope_key].append(_view(r))
        return out

    def get(self, execution_id: int) -> ExecutionView:
        try:
            self._settle_stale()
            row = self._fresh(execution_id)
            if row is None:
                raise ExecutionNotFoundError()
            return _view(row)
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise ExecutionUnavailableError() from exc

    # -------------------------------------------------------------- authorize
    def _check_version_locked(self, artifact_id: int, version_id: int, approval_id: int | None = None):
        """Fresh, locked re-read of what a stop operation can change. Returns (view, action-independent)."""
        artifact = self._repo.get_artifact_locked(artifact_id)
        if artifact is None or artifact.current_version_id != version_id:
            raise ExecutionStaleVersionError()
        version = self._repo.get_artifact_version(version_id)
        approval = self._repo.get_approval_for_version(version_id)
        if (
            version is None or approval is None or approval.artifact_id != artifact_id
            or approval.content_sha256 != content_sha256(version.content_json)
            or (approval_id is not None and approval.id != approval_id)
        ):
            raise ExecutionNotApprovedError()
        view = self._plans.get_version(artifact_id, version_id)
        for sid in view.source_screenshot_ids:
            shot = self._repo.get_screenshot_locked(sid)
            if shot is None or shot.state != "active":
                raise ExecutionArchivedError()
        return view, approval

    def authorize(self, artifact_id: int, version_id: int, action_index: int, content_hash: str) -> Reservation:
        """All checks, then the atomic reservation (``reserved``). Commits; sends nothing."""
        transport = self._transport
        if config.EXTERNAL_TOOLS_MODE == "off" or transport is None or transport.mode != config.EXTERNAL_TOOLS_MODE:
            raise ExecutionDisabledError()
        if transport.mode == "composio" and not config.COMPOSIO_ALLOW_LIVE_WRITES:
            raise LiveWritesDisabledError()
        try:
            view = self._plans.get_version(artifact_id, version_id)
            artifact = self._repo.get_artifact(artifact_id)
            if artifact is None or artifact.current_version_id != view.version_id:
                raise ExecutionStaleVersionError()
            approval = self._repo.get_approval_for_version(view.version_id)
            if (
                approval is None
                or approval.artifact_id != artifact_id
                or approval.content_sha256 != view.content_sha256
                or not isinstance(content_hash, str)
                or content_hash != approval.content_sha256
            ):
                raise ExecutionNotApprovedError()
            action = find_action(view.content, action_index)
            if action is None:
                raise ExecutionNotFoundError()
            if not action.enabled or action.tool not in CATALOG or view.content.decision != "act":
                raise ExecutionIncompleteError()
            dest = action.destination
            if view.content.tools_mode != transport.mode or dest is None or dest.mode != transport.mode:
                raise ExecutionReconnectError()
            require_sources_active(self._repo, view.source_screenshot_ids)
            screenshot_id = view.source_screenshot_ids[0]
            scope = scope_key(self._workspace_id, screenshot_id, action)
            key = delivery_key(self._workspace_id, screenshot_id, action)
            arguments = build_arguments(action, key)
            self._session.rollback()
        except ActionPlanNotFoundError as exc:
            self._session.rollback()
            raise ExecutionNotFoundError() from exc
        except DraftSourceArchivedError as exc:
            self._session.rollback()
            raise ExecutionArchivedError() from exc
        except ArgumentError as exc:
            self._session.rollback()
            raise ExecutionIncompleteError() from exc
        except ExecutionError:
            self._session.rollback()
            raise
        except (ActionPlanUnavailableError, DraftSourceMissingError, SQLAlchemyError) as exc:
            self._session.rollback()
            raise ExecutionUnavailableError() from exc
        # Early provider check (no lock held): refuse before reserving when the
        # account is already unusable. Repeated at the dispatch boundary.
        self._verify_remote(dest, action.toolkit)
        try:
            if self._repo.lock_workspace() is None:
                raise ExecutionNotFoundError()
            self._settle_overdue_locked()
            locked_view, locked_approval = self._check_version_locked(artifact_id, version_id)
            if locked_view.content_sha256 != content_hash:
                raise ExecutionNotApprovedError()
            self._require_connection_locked(dest.connection_id, dest.connected_account_id, action.toolkit)
            conflict = self._conflict_locked(scope, key)
            if conflict is not None:
                existing = _view(conflict)
                self._session.rollback()
                raise ExecutionDuplicateError(existing)
            same_action = [r for r in self._tools.list_executions(artifact_id) if r.action_index == action.index]
            row = self._tools.add_execution(
                artifact_id=artifact_id,
                artifact_version_id=version_id,
                approval_id=locked_approval.id,
                screenshot_id=screenshot_id,
                scope_key=scope,
                action_index=action.index,
                attempt=max((r.attempt for r in same_action), default=0) + 1,
                tool_slug=action.tool,
                toolkit=action.toolkit,
                toolkit_version=action.toolkit_version,
                connection_id=dest.connection_id,
                mode=transport.mode,
                delivery_key=key,
                arguments_sha256=arguments_sha256(arguments),
                status=RESERVED,
            )
            reservation = Reservation(execution_id=row.id, arguments=arguments)
            self._session.commit()  # reserved: provably not sent
            return reservation
        except ExecutionError:
            self._session.rollback()
            raise
        except IntegrityError as exc:
            # The partial unique indexes caught a concurrent reservation.
            self._session.rollback()
            raise ExecutionDuplicateError(self._conflict_view(scope, key)) from exc
        except (ActionPlanNotFoundError, ActionPlanUnavailableError, CrossWorkspaceError, SQLAlchemyError) as exc:
            self._session.rollback()
            raise ExecutionUnavailableError() from exc

    def _conflict_locked(self, scope: str, key: str) -> models.ToolExecution | None:
        return self._session.scalars(
            select(models.ToolExecution)
            .where(
                models.ToolExecution.workspace_id == self._workspace_id,
                or_(
                    (models.ToolExecution.scope_key == scope) & models.ToolExecution.status.in_(UNRESOLVED),
                    (models.ToolExecution.delivery_key == key) & models.ToolExecution.status.in_(HELD),
                ),
            )
            .order_by(models.ToolExecution.id.desc())
            .limit(1)
            .execution_options(populate_existing=True)
        ).first()

    def _conflict_view(self, scope: str, key: str) -> ExecutionView | None:
        try:
            row = self._conflict_locked(scope, key)
            self._session.rollback()
            return _view(row) if row is not None else None
        except SQLAlchemyError:
            self._session.rollback()
            return None

    def _require_connection_locked(self, connection_id: int, account_id: str, toolkit: str) -> None:
        connection = self._session.scalars(
            select(models.ToolConnection)
            .where(models.ToolConnection.id == connection_id, models.ToolConnection.workspace_id == self._workspace_id)
            .execution_options(populate_existing=True)
        ).one_or_none()
        current = self._tools.current_connection(toolkit)
        if (
            connection is None or current is None or connection.id != current.id
            or connection.status != "active" or connection.connected_account_id != account_id
        ):
            raise ExecutionReconnectError()

    def _verify_remote(self, dest, toolkit: str) -> str:
        try:
            return self._connections.verify_for_execution(dest.connection_id, dest.connected_account_id, toolkit)
        except ConnectionNotActiveError as exc:
            raise ExecutionReconnectError() from exc
        except ToolsDisabledError as exc:
            raise ExecutionDisabledError() from exc
        except ConnectionUnavailableError as exc:
            raise ExecutionUnavailableError() from exc

    # --------------------------------------------------------------- dispatch
    def _cancel(self, execution_id: int, detail: str) -> ExecutionView | None:
        try:
            if self._repo.lock_workspace() is None:
                self._session.rollback()
                return None
            self._transition(execution_id, RESERVED, status=CANCELLED, error_detail=detail, completed_at=_now())
            self._session.commit()
            row = self._fresh(execution_id)
            self._session.rollback()
            return _view(row) if row is not None else None
        except SQLAlchemyError:
            self._session.rollback()
            return None  # stays reserved -> cancelled by the stale sweep; never sent

    def dispatch(self, reservation: Reservation) -> ExecutionView | None:
        """Re-authorize at the boundary, linearize, then send exactly once."""
        transport = self._transport
        try:
            row = self._fresh(reservation.execution_id)
            if row is None or row.status != RESERVED:
                self._session.rollback()
                return _view(row) if row is not None else None
            snapshot = (row.artifact_id, row.artifact_version_id, row.approval_id, row.action_index,
                        row.connection_id, row.toolkit, row.tool_slug, row.toolkit_version, row.delivery_key,
                        row.scope_key, row.arguments_sha256, row.mode)
            connection = self._tools.get_connection(row.connection_id)
            account_id = connection.connected_account_id if connection is not None else None
            self._session.rollback()
        except SQLAlchemyError:
            self._session.rollback()
            return None  # stays reserved; never sent
        (artifact_id, version_id, approval_id, index, connection_id, toolkit, slug, version, key, scope,
         args_sha, mode) = snapshot
        if (
            transport is None or transport.mode != mode or mode != config.EXTERNAL_TOOLS_MODE
            or (mode == "composio" and not config.COMPOSIO_ALLOW_LIVE_WRITES)
            or account_id is None or arguments_sha256(reservation.arguments) != args_sha
        ):
            return self._cancel(reservation.execution_id, "Cancelled before sending: the request no longer matched its approval.")

        dest = SimpleNamespace(connection_id=connection_id, connected_account_id=account_id)  # the reserved binding
        # 1. Provider re-check of ownership and status, with no lock held.
        try:
            user_id = self._verify_remote(dest, toolkit)
        except ExecutionError:
            return self._cancel(reservation.execution_id,
                                "Cancelled before sending: the account could not be confirmed. Reconnect and try again.")
        # 2. Locked, fresh re-validation; then the linearization point.
        try:
            if self._repo.lock_workspace() is None:
                self._session.rollback()
                return None
            refusal: str | None = None
            try:
                view, _approval = self._check_version_locked(artifact_id, version_id, approval_id)
                action = find_action(view.content, index)
                if (
                    action is None or not action.enabled or action.tool != slug or action.toolkit_version != version
                    or action.destination is None or action.destination.connection_id != connection_id
                    or action.destination.connected_account_id != account_id
                ):
                    raise ExecutionStaleVersionError()
                sid = view.source_screenshot_ids[0]
                if delivery_key(self._workspace_id, sid, action) != key or scope_key(self._workspace_id, sid, action) != scope:
                    raise ExecutionStaleVersionError()
                if arguments_sha256(build_arguments(action, key)) != args_sha:
                    raise ExecutionStaleVersionError()
                self._require_connection_locked(connection_id, account_id, toolkit)
            except (ExecutionError, ArgumentError, ActionPlanNotFoundError, ActionPlanUnavailableError) as exc:
                refusal = getattr(exc, "message", "the plan changed")
            if refusal is not None:
                self._transition(reservation.execution_id, RESERVED, status=CANCELLED,
                                 error_detail=f"Cancelled before sending: {refusal}.", completed_at=_now())
                self._session.commit()
                row = self._fresh(reservation.execution_id)
                self._session.rollback()
                return _view(row) if row is not None else None
            if not self._transition(reservation.execution_id, RESERVED, status=EXECUTING, dispatched_at=_now()):
                self._session.rollback()  # cancelled or settled by someone else: never send
                row = self._fresh(reservation.execution_id)
                self._session.rollback()
                return _view(row) if row is not None else None
            self._session.commit()  # LINEARIZATION POINT: possibly sent from here on
        except SQLAlchemyError:
            self._session.rollback()
            return None  # not committed -> still reserved -> never sent
        # 3. Exactly one provider call, no transaction open.
        try:
            result = transport.execute_tool(slug, user_id=user_id, connected_account_id=account_id,
                                            version=version, arguments=reservation.arguments)
        except ToolNotSentError:
            return self._settle(reservation.execution_id, FAILED, _DETAIL[FAILED])
        except ToolRejectedError:
            # A provider "no" after the request left this process is not proof
            # of non-execution: unknown, never retried.
            return self._settle(reservation.execution_id, UNKNOWN, _DETAIL[UNKNOWN])
        except ToolOutcomeUnknownError:
            return self._settle(reservation.execution_id, UNKNOWN, _DETAIL[UNKNOWN])
        except Exception:
            return self._settle(reservation.execution_id, UNKNOWN, _DETAIL[UNKNOWN])
        try:
            external_id, url, verified = extract_receipt(slug, result.data, key)
        except ReceiptError:
            return self._settle(reservation.execution_id, UNKNOWN, _DETAIL[UNKNOWN], log_id=result.log_id)
        return self._settle(reservation.execution_id, SUCCEEDED, None if verified else _DETAIL["unverified"],
                            external_id=external_id, url=url, log_id=result.log_id, verified=verified)

    def _settle(self, execution_id: int, status: str, detail: str | None, *, external_id: str | None = None,
                url: str | None = None, log_id: str | None = None, verified: bool | None = None) -> ExecutionView | None:
        try:
            if self._repo.lock_workspace() is None:
                self._session.rollback()
                return None
            now = _now()
            # Conditional: a row already settled (e.g. by the stale sweep) is never overwritten.
            self._transition(
                execution_id, EXECUTING, status=status, error_detail=detail, external_id=external_id,
                external_url=url, provider_log_id=(log_id or None) and log_id[:128],
                receipt_verified=verified, completed_at=now,
            )
            self._session.commit()
            row = self._fresh(execution_id)
            self._session.rollback()
            return _view(row) if row is not None else None
        except SQLAlchemyError:
            self._session.rollback()
            return None  # stays executing -> reported unknown after the stale window


def cancel_reserved_locked(session: Session, workspace_id: int, *, connection_ids: list[int] | None = None,
                           artifact_id: int | None = None, screenshot_id: int | None = None, detail: str) -> int:
    """For stop operations, inside THEIR locked transaction: cancel unsent reservations.

    Only ``reserved`` rows change (conditional UPDATE). An ``executing`` row
    passed the linearization point and is deliberately left alone: a write
    that may already be at the provider cannot be cancelled.
    """
    conditions = [models.ToolExecution.workspace_id == workspace_id, models.ToolExecution.status == RESERVED]
    if connection_ids is not None:
        if not connection_ids:
            return 0
        conditions.append(models.ToolExecution.connection_id.in_(connection_ids))
    if artifact_id is not None:
        conditions.append(models.ToolExecution.artifact_id == artifact_id)
    if screenshot_id is not None:
        conditions.append(models.ToolExecution.screenshot_id == screenshot_id)
    now = _now()
    result = session.execute(
        update(models.ToolExecution).where(*conditions)
        .values(status=CANCELLED, error_detail=detail, completed_at=now, updated_at=now)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount
