"""Connected applications for one workspace (Composio connected accounts).

Isolation model (anonymous workspaces, no user accounts):

* each workspace gets ONE random provider user id (``external_identity``),
  never derived from its cookie token, so no two workspaces share a provider
  user and therefore never share a connected account;
* a connected account id is recorded ONLY from the provider's response to a
  link request this server made for this workspace's provider user. Ids in the
  browser, the callback URL or the AI output are never trusted;
* before anything uses an account, the provider is asked again: the account
  must exist, be ACTIVE, belong to this workspace's provider user, and be of
  the expected toolkit. Anything else marks the connection failed.

Completion of a hosted connection (Composio's guidance: "verify its
connected_account_id against the connection attempt stored on your server and
the signed-in application user ... Callback query parameters alone aren't
proof of ownership"): each connect creates a server-controlled ATTEMPT, a
random single-use token (only its SHA-256 is stored) that expires after
``ATTEMPT_TTL``. The token travels only inside the callback URL given to the
hosted page, so it reaches only the browser that completed that page. A
pending connection becomes ``active`` ONLY when that token is presented back
to ``complete`` by the SAME workspace (cookie) before expiry, the callback's
account id (if any) equals the one recorded for the attempt, and the provider
confirms the account (owner, toolkit, ACTIVE). Provider status alone, a
redirect alone, or a token presented by another workspace never activates a
connection. What this cannot prove: WHICH Google/Notion/Gmail identity the
person authorized (a leaked hosted link completed in the victim's own browser
still binds the identity used there). That is why public (production)
connecting stays off unless ``COMPOSIO_PUBLIC_CONNECT=1``.

No network call runs while the workspace write lock is held. Disconnect is
local first (the account is never used again from that commit on), then the
account is deleted at the provider; a failed remote delete is reported
honestly instead of being hidden.
"""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit, urlunsplit

from sqlalchemy import select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import config
from app.db import models
from app.db.repository import WorkspaceRepository
from app.db.tool_repository import ToolRepository
from app.tools.catalog import CATALOG, TOOLKIT_LABELS, TOOLKITS
from app.tools.provider import get_tool_transport
from app.tools.transport import ToolNotFoundError, ToolTransport, ToolTransportError

_PENDING_PROVIDER = frozenset({"INITIALIZING", "INITIATED"})
ATTEMPT_TTL = timedelta(minutes=10)
ATTEMPT_PARAM = "sg_attempt"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _callback_with_attempt(base: str, token: str) -> str:
    parts = urlsplit(base)
    query = (parts.query + "&" if parts.query else "") + urlencode({ATTEMPT_PARAM: token})
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


class ConnectionError_(Exception):
    """Base error (safe messages only)."""


class ToolsDisabledError(ConnectionError_):
    """EXTERNAL_TOOLS_MODE=off."""


class ToolkitNotFoundError(ConnectionError_):
    """Not a supported toolkit."""


class ToolkitNotConfiguredError(ConnectionError_):
    """No auth config for this toolkit on this deployment."""


class ConnectionUnavailableError(ConnectionError_):
    """Database or provider unavailable; nothing was changed."""


class ConnectionNotActiveError(ConnectionError_):
    """The account is not (or no longer) usable: reconnect."""


class ConnectionAttemptError(ConnectionError_):
    """No valid, unexpired, unused attempt of THIS workspace matches (non-disclosing)."""


class PublicConnectDisabledError(ConnectionError_):
    """Hosted connections are restricted to controlled local test accounts."""


@dataclass(frozen=True)
class ConnectionView:
    toolkit: str
    label: str
    configured: bool
    # not_connected | pending | active | failed
    status: str
    connection_id: int | None
    mode: str | None
    tools: list[str]
    live_verified_tools: list[str]

    @property
    def simulated(self) -> bool:
        return self.mode == "fake"


def tools_mode() -> str:
    return config.EXTERNAL_TOOLS_MODE


def toolkit_configured(toolkit: str) -> bool:
    if tools_mode() == "fake":
        return True
    if tools_mode() == "composio":
        return toolkit in config.COMPOSIO_AUTH_CONFIGS
    return False


class ToolConnectionService:
    def __init__(self, session: Session, workspace_id: int, *, transport: ToolTransport | None = None) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        self._session = session
        self._repo = WorkspaceRepository(session, workspace_id)
        self._tools = ToolRepository(session, workspace_id)
        self._transport = transport if transport is not None else get_tool_transport()

    # -------------------------------------------------------------- helpers
    def _require_enabled(self) -> ToolTransport:
        if tools_mode() == "off" or self._transport is None:
            raise ToolsDisabledError("external tools are not enabled")
        if self._transport.mode != tools_mode():
            raise ToolsDisabledError("external tools are not enabled")
        return self._transport

    @staticmethod
    def _require_toolkit(toolkit: str) -> str:
        if toolkit not in TOOLKITS:
            raise ToolkitNotFoundError("unknown toolkit")
        return toolkit

    def _view(self, toolkit: str, row) -> ConnectionView:
        tools = sorted(t.slug for t in CATALOG.values() if t.toolkit == toolkit)
        status = "not_connected"
        if row is not None and row.mode == tools_mode():
            status = row.status if row.status in {"pending", "active", "failed"} else "not_connected"
        return ConnectionView(
            toolkit=toolkit,
            label=TOOLKIT_LABELS[toolkit],
            configured=toolkit_configured(toolkit),
            status=status,
            connection_id=row.id if status != "not_connected" else None,
            mode=row.mode if status != "not_connected" else None,
            tools=tools,
            live_verified_tools=sorted(
                s for s in tools if s in config.COMPOSIO_LIVE_VERIFIED_TOOLS and tools_mode() == "composio"
            ),
        )

    @staticmethod
    def _require_public_connect_allowed(transport: ToolTransport) -> None:
        if transport.mode == "composio" and config.IS_PRODUCTION and not config.COMPOSIO_PUBLIC_CONNECT:
            raise PublicConnectDisabledError("public connections are disabled")

    # ---------------------------------------------------------------- reads
    def list(self) -> list[ConnectionView]:
        try:
            return [self._view(t, self._tools.current_connection(t)) for t in TOOLKITS]
        except SQLAlchemyError as exc:
            raise ConnectionUnavailableError("connections unavailable") from exc

    def current(self, toolkit: str) -> ConnectionView:
        self._require_toolkit(toolkit)
        try:
            return self._view(toolkit, self._tools.current_connection(toolkit))
        except SQLAlchemyError as exc:
            raise ConnectionUnavailableError("connections unavailable") from exc

    # --------------------------------------------------------------- writes
    def connect(self, toolkit: str) -> tuple[ConnectionView, str | None]:
        """Start (or reuse) a connection. Returns the view and the hosted URL, if any."""
        transport = self._require_enabled()
        self._require_toolkit(toolkit)
        if not toolkit_configured(toolkit):
            raise ToolkitNotConfiguredError("toolkit not configured")
        if transport.mode == "composio":
            self._require_public_connect_allowed(transport)
            if not config.COMPOSIO_CALLBACK_URL:
                # Without a callback carrying our attempt token, completion can
                # never be bound to this workspace: refuse rather than guess.
                raise ToolkitNotConfiguredError("callback not configured")
        token = secrets.token_urlsafe(32)
        callback = _callback_with_attempt(config.COMPOSIO_CALLBACK_URL, token) if config.COMPOSIO_CALLBACK_URL else None
        try:
            if self._repo.lock_workspace() is None:
                raise ConnectionUnavailableError("connections unavailable")
            current = self._tools.current_connection(toolkit)
            if current is not None and current.status == "active" and current.mode == transport.mode:
                view = self._view(toolkit, current)
                self._session.rollback()
                return view, None  # already connected: no second account
            user_id = self._tools.get_or_create_external_user_id()
            self._session.commit()
        except ConnectionError_:
            self._session.rollback()
            raise
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise ConnectionUnavailableError("connections unavailable") from exc
        try:
            link = transport.create_link(
                user_id=user_id,
                toolkit=toolkit,
                auth_config_id=config.COMPOSIO_AUTH_CONFIGS.get(toolkit),
                callback_url=callback,
            )
        except ToolTransportError as exc:
            raise ConnectionUnavailableError("could not start the connection") from exc
        try:
            if self._repo.lock_workspace() is None:
                raise ConnectionUnavailableError("connections unavailable")
            # Supersede older unfinished links: only the newest one may become active.
            for old in self._tools.open_connections(toolkit):
                if old.status != "active":
                    self._tools.set_connection_status(old, "disconnected")
            row = self._tools.add_connection(
                toolkit=toolkit, mode=transport.mode,
                connected_account_id=link.connected_account_id, status="pending",
            )
            row.attempt_token_sha256 = _token_hash(token)
            row.attempt_expires_at = _now() + ATTEMPT_TTL
            self._session.flush()
            self._session.commit()
            row_id = row.id
        except ConnectionError_:
            self._session.rollback()
            raise
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise ConnectionUnavailableError("connections unavailable") from exc
        if link.redirect_url is None:
            if transport.mode != "fake":
                raise ConnectionUnavailableError("could not start the connection")
            # Simulated: there is no hosted page and no third-party identity.
            # The server itself presents the attempt in the same request.
            return self.complete(token, link.connected_account_id), None
        return self._view(toolkit, self._tools.get_connection(row_id)), link.redirect_url

    def complete(self, token: object, callback_account_id: object = None) -> ConnectionView:
        """Finish a hosted connection with its single-use attempt token (this workspace only)."""
        transport = self._require_enabled()
        # The production gate covers EVERY activation path, including attempts
        # created before it was switched on. Nothing is consumed or changed.
        self._require_public_connect_allowed(transport)
        if not isinstance(token, str) or not 20 <= len(token) <= 128:
            raise ConnectionAttemptError("invalid attempt")
        if callback_account_id is not None and not isinstance(callback_account_id, str):
            raise ConnectionAttemptError("invalid attempt")
        digest = _token_hash(token)
        try:
            row = self._session.scalars(
                select(models.ToolConnection).where(
                    models.ToolConnection.workspace_id == self._repo.workspace_id,
                    models.ToolConnection.attempt_token_sha256 == digest,
                )
            ).one_or_none()
            user_id = self._tools.get_external_user_id()
            if (
                row is None or user_id is None or row.status != "pending" or row.mode != transport.mode
                or row.attempt_consumed_at is not None
                or _aware(row.attempt_expires_at) is None or _aware(row.attempt_expires_at) <= _now()
                or (callback_account_id is not None and callback_account_id != row.connected_account_id)
            ):
                self._session.rollback()
                raise ConnectionAttemptError("invalid attempt")
            row_id, toolkit, account_id = row.id, row.toolkit, row.connected_account_id
            self._session.rollback()
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise ConnectionUnavailableError("connections unavailable") from exc
        try:
            info = transport.get_connected_account(account_id)
            owned = info.connected_account_id == account_id and info.user_id == user_id and info.toolkit == toolkit
            status = "active" if owned and info.status == "ACTIVE" and not info.disabled else (
                "pending" if owned and info.status in _PENDING_PROVIDER else "failed")
        except ToolNotFoundError:
            status = "failed"
        except ToolTransportError as exc:
            raise ConnectionUnavailableError("could not check the connection") from exc
        if status == "pending":
            return self._view(toolkit, self._tools.get_connection(row_id))  # not consumed: may complete shortly
        try:
            if self._repo.lock_workspace() is None:
                raise ConnectionUnavailableError("connections unavailable")
            now = _now()
            # Single use: consume only if still pending, unexpired and unconsumed.
            result = self._session.execute(
                update(models.ToolConnection)
                .where(
                    models.ToolConnection.id == row_id,
                    models.ToolConnection.workspace_id == self._repo.workspace_id,
                    models.ToolConnection.status == "pending",
                    models.ToolConnection.attempt_consumed_at.is_(None),
                    models.ToolConnection.attempt_expires_at > now,
                )
                .values(status=status, attempt_consumed_at=now, updated_at=now)
                .execution_options(synchronize_session=False)
            )
            if result.rowcount != 1:
                self._session.rollback()
                raise ConnectionAttemptError("invalid attempt")
            self._session.commit()
            self._session.expire_all()
            return self._view(toolkit, self._tools.current_connection(toolkit))
        except ConnectionError_:
            self._session.rollback()
            raise
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise ConnectionUnavailableError("connections unavailable") from exc

    def refresh(self, toolkit: str) -> ConnectionView:
        """Re-read the current connection's status from the provider and record it.

        A refresh can only keep a connection active, mark it failed, or expire an
        unfinished attempt. It never ACTIVATES a pending connection: that needs
        :meth:`complete` with the attempt token.
        """
        transport = self._require_enabled()
        self._require_toolkit(toolkit)
        try:
            row = self._tools.current_connection(toolkit)
            user_id = self._tools.get_external_user_id()
            if row is None or row.mode != transport.mode or user_id is None:
                return self._view(toolkit, row)
            row_id, account_id = row.id, row.connected_account_id
            self._session.rollback()
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise ConnectionUnavailableError("connections unavailable") from exc
        try:
            info = transport.get_connected_account(account_id)
            if info.connected_account_id != account_id or info.user_id != user_id or info.toolkit != toolkit:
                status = "failed"  # not this workspace's account: never use it
            elif info.status == "ACTIVE" and not info.disabled:
                status = "active"
            elif info.status in _PENDING_PROVIDER:
                status = "pending"
            else:
                status = "failed"
        except ToolNotFoundError:
            status = "failed"
        except ToolTransportError as exc:
            raise ConnectionUnavailableError("could not check the connection") from exc
        try:
            if self._repo.lock_workspace() is None:
                raise ConnectionUnavailableError("connections unavailable")
            fresh = self._session.get(models.ToolConnection, row_id, populate_existing=True)
            if fresh is not None and fresh.workspace_id == self._repo.workspace_id and fresh.status != "disconnected":
                if fresh.status == "pending":
                    expired = _aware(fresh.attempt_expires_at) is None or _aware(fresh.attempt_expires_at) <= _now()
                    # Provider ACTIVE is not proof of who completed it: stay pending.
                    target = "failed" if status == "failed" or expired else "pending"
                else:
                    target = "active" if status == "active" else "failed"
                if target != fresh.status:
                    self._tools.set_connection_status(fresh, target)
                    if target == "failed":
                        self._cancel_reserved([fresh.id], "Cancelled before sending: the account is no longer usable.")
            self._session.commit()
            return self._view(toolkit, self._tools.current_connection(toolkit))
        except ConnectionError_:
            self._session.rollback()
            raise
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise ConnectionUnavailableError("connections unavailable") from exc

    def disconnect(self, toolkit: str) -> tuple[ConnectionView, bool]:
        """Stop using every open connection for ``toolkit``; then delete it remotely.

        Returns ``(view, removed_at_provider)``. The local change is committed
        first, so the account is never used again even if the remote delete fails.
        """
        transport = self._require_enabled()
        self._require_toolkit(toolkit)
        try:
            if self._repo.lock_workspace() is None:
                raise ConnectionUnavailableError("connections unavailable")
            rows = self._tools.open_connections(toolkit)
            targets = [(r.connected_account_id, r.mode) for r in rows]
            for r in rows:
                self._tools.set_connection_status(r, "disconnected")
            # Same transaction: unsent reservations on these accounts are cancelled.
            self._cancel_reserved([r.id for r in rows], "Cancelled before sending: the app was disconnected.")
            self._session.commit()
        except ConnectionError_:
            self._session.rollback()
            raise
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise ConnectionUnavailableError("connections unavailable") from exc
        removed = True
        for account_id, mode in targets:
            if mode != transport.mode:
                removed = False
                continue
            try:
                transport.delete_connected_account(account_id)
            except ToolNotFoundError:
                pass  # already gone at the provider
            except ToolTransportError:
                removed = False
        return self._view(toolkit, None), removed

    def _cancel_reserved(self, connection_ids: list[int], detail: str) -> None:
        from app.services.tool_execution_service import cancel_reserved_locked  # avoids an import cycle

        cancel_reserved_locked(self._session, self._repo.workspace_id, connection_ids=connection_ids, detail=detail)

    # ------------------------------------------------------- execution gate
    def verify_for_execution(self, connection_id: int, connected_account_id: str, toolkit: str) -> str:
        """Prove the bound account is still this workspace's and active. Returns the provider user id.

        Raises :class:`ConnectionNotActiveError` (and records ``failed``) when
        the account is disconnected, revoked, expired, reassigned or replaced.
        """
        transport = self._require_enabled()
        try:
            row = self._tools.get_connection(connection_id)
            user_id = self._tools.get_external_user_id()
            current = self._tools.current_connection(toolkit)
            self._session.rollback()
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise ConnectionUnavailableError("connections unavailable") from exc
        if (
            row is None or user_id is None or current is None
            or row.id != current.id
            or row.status != "active"
            or row.toolkit != toolkit
            or row.mode != transport.mode
            or row.connected_account_id != connected_account_id
        ):
            raise ConnectionNotActiveError("reconnect required")
        try:
            info = transport.get_connected_account(connected_account_id)
            usable = (
                info.connected_account_id == connected_account_id
                and info.user_id == user_id
                and info.toolkit == toolkit
                and info.status == "ACTIVE"
                and not info.disabled
            )
        except ToolNotFoundError:
            usable = False
        except ToolTransportError as exc:
            raise ConnectionUnavailableError("could not check the connection") from exc
        if not usable:
            try:
                if self._repo.lock_workspace() is not None:
                    fresh = self._session.get(models.ToolConnection, connection_id, populate_existing=True)
                    if fresh is not None and fresh.workspace_id == self._repo.workspace_id and fresh.status == "active":
                        self._tools.set_connection_status(fresh, "failed")
                        self._cancel_reserved([fresh.id], "Cancelled before sending: the account is no longer usable.")
                self._session.commit()
            except SQLAlchemyError:
                self._session.rollback()
            raise ConnectionNotActiveError("reconnect required")
        return user_id
