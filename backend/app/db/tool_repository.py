"""Workspace-scoped data access for external identities, connections and executions.

Same contract as ``WorkspaceRepository``: bound to one trusted workspace id,
every read filters by it, every insert stamps it, and every foreign key is
verified to belong to the same workspace before it is written. There is no
unscoped path. Callers own the transaction (and take ``lock_workspace`` from
``WorkspaceRepository`` where a decision must be atomic).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import models
from app.db.repository import CrossWorkspaceError, WorkspaceRepository


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ToolRepository:
    def __init__(self, session: Session, workspace_id: int) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required; there is no unscoped repository")
        self._session = session
        self._workspace_id = workspace_id
        self._base = WorkspaceRepository(session, workspace_id)

    # ------------------------------------------------------------ identity
    def get_external_user_id(self) -> str | None:
        row = self._session.scalars(
            select(models.ExternalIdentity).where(models.ExternalIdentity.workspace_id == self._workspace_id)
        ).one_or_none()
        return row.external_user_id if row is not None else None

    def get_or_create_external_user_id(self) -> str:
        """Caller holds the workspace lock and commits."""
        existing = self.get_external_user_id()
        if existing is not None:
            return existing
        user_id = "sg_" + secrets.token_urlsafe(24)
        self._session.add(models.ExternalIdentity(workspace_id=self._workspace_id, external_user_id=user_id))
        self._session.flush()
        return user_id

    # ---------------------------------------------------------- connections
    def add_connection(self, *, toolkit: str, mode: str, connected_account_id: str, status: str) -> models.ToolConnection:
        row = models.ToolConnection(
            workspace_id=self._workspace_id, toolkit=toolkit, mode=mode,
            connected_account_id=connected_account_id, status=status,
        )
        self._session.add(row)
        self._session.flush()
        return row

    def get_connection(self, connection_id: int) -> models.ToolConnection | None:
        if type(connection_id) is not int:
            return None
        return self._session.scalars(
            select(models.ToolConnection).where(
                models.ToolConnection.id == connection_id,
                models.ToolConnection.workspace_id == self._workspace_id,
            )
        ).one_or_none()

    def current_connection(self, toolkit: str) -> models.ToolConnection | None:
        """The newest connection for ``toolkit`` that is not disconnected."""
        return self._session.scalars(
            select(models.ToolConnection)
            .where(
                models.ToolConnection.workspace_id == self._workspace_id,
                models.ToolConnection.toolkit == toolkit,
                models.ToolConnection.status != "disconnected",
            )
            .order_by(models.ToolConnection.id.desc())
            .limit(1)
        ).first()

    def open_connections(self, toolkit: str) -> list[models.ToolConnection]:
        return list(self._session.scalars(
            select(models.ToolConnection).where(
                models.ToolConnection.workspace_id == self._workspace_id,
                models.ToolConnection.toolkit == toolkit,
                models.ToolConnection.status != "disconnected",
            )
        ))

    def set_connection_status(self, connection: models.ToolConnection, status: str) -> None:
        if connection.workspace_id != self._workspace_id:
            raise CrossWorkspaceError()
        connection.status = status
        connection.updated_at = _utcnow()
        self._session.flush()

    # ----------------------------------------------------------- executions
    def list_executions(self, artifact_id: int) -> list[models.ToolExecution]:
        return list(self._session.scalars(
            select(models.ToolExecution)
            .where(
                models.ToolExecution.workspace_id == self._workspace_id,
                models.ToolExecution.artifact_id == artifact_id,
            )
            .order_by(models.ToolExecution.action_index, models.ToolExecution.attempt)
        ))

    def get_execution(self, execution_id: int) -> models.ToolExecution | None:
        if type(execution_id) is not int:
            return None
        return self._session.scalars(
            select(models.ToolExecution).where(
                models.ToolExecution.id == execution_id,
                models.ToolExecution.workspace_id == self._workspace_id,
            )
        ).one_or_none()

    def get_execution_fresh(self, execution_id: int) -> models.ToolExecution | None:
        row = self.get_execution(execution_id)
        if row is not None:
            self._session.refresh(row)
        return row

    def add_execution(self, **values) -> models.ToolExecution:
        # Every parent must belong to this workspace before it is linked.
        if self._base.get_artifact(values["artifact_id"]) is None:
            raise CrossWorkspaceError()
        version = self._base.get_artifact_version(values["artifact_version_id"])
        if version is None or version.artifact_id != values["artifact_id"]:
            raise CrossWorkspaceError()
        approval = self._base.get_approval_for_version(values["artifact_version_id"])
        if approval is None or approval.id != values["approval_id"]:
            raise CrossWorkspaceError()
        if self.get_connection(values["connection_id"]) is None:
            raise CrossWorkspaceError()
        if self._base.get_screenshot(values["screenshot_id"]) is None:
            raise CrossWorkspaceError()
        row = models.ToolExecution(workspace_id=self._workspace_id, **values)
        self._session.add(row)
        self._session.flush()
        return row
