"""External tools via Composio: identity, connections, executions
Adds ``external_identity`` (one opaque provider user id per workspace),
``tool_connection`` (connected accounts bound to one workspace) and
``tool_execution`` (one row per authorized external-write attempt, reserved
before dispatch, with a stable delivery identity guarded by partial unique
indexes). Additive only; no existing table or row is changed.

Revision ID: f8d3c0a50001
Revises: e7c2a9b00001
Create Date: 2026-11-28 09:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f8d3c0a50001"
down_revision: Union[str, Sequence[str], None] = "e7c2a9b00001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts(name: str, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "external_identity",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("external_user_id", sa.String(length=64), nullable=False),
        _ts("created_at"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"],
                                name=op.f("fk_external_identity_workspace_id_workspace")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_external_identity")),
        sa.UniqueConstraint("workspace_id", name="external_identity_workspace"),
        sa.UniqueConstraint("external_user_id", name="external_identity_user"),
    )
    with op.batch_alter_table("external_identity", schema=None) as b:
        b.create_index("ix_external_identity_workspace_id", ["workspace_id"], unique=False)

    op.create_table(
        "tool_connection",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("toolkit", sa.String(length=32), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("connected_account_id", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempt_token_sha256", sa.String(length=64), nullable=True),
        _ts("attempt_expires_at", nullable=True),
        _ts("attempt_consumed_at", nullable=True),
        _ts("created_at"),
        _ts("updated_at"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"],
                                name=op.f("fk_tool_connection_workspace_id_workspace")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tool_connection")),
    )
    with op.batch_alter_table("tool_connection", schema=None) as b:
        b.create_index("ix_tool_connection_workspace_id", ["workspace_id"], unique=False)
        b.create_index("ix_tool_connection_workspace_toolkit", ["workspace_id", "toolkit"], unique=False)

    op.create_table(
        "tool_execution",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("artifact_id", sa.Integer(), nullable=False),
        sa.Column("artifact_version_id", sa.Integer(), nullable=False),
        sa.Column("approval_id", sa.Integer(), nullable=False),
        sa.Column("screenshot_id", sa.Integer(), nullable=False),
        sa.Column("scope_key", sa.String(length=64), nullable=False),
        sa.Column("action_index", sa.Integer(), nullable=False),
        sa.Column("attempt", sa.Integer(), nullable=False),
        sa.Column("tool_slug", sa.String(length=64), nullable=False),
        sa.Column("toolkit", sa.String(length=32), nullable=False),
        sa.Column("toolkit_version", sa.String(length=64), nullable=False),
        sa.Column("connection_id", sa.Integer(), nullable=False),
        sa.Column("mode", sa.String(length=16), nullable=False),
        sa.Column("delivery_key", sa.String(length=64), nullable=False),
        sa.Column("arguments_sha256", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("external_id", sa.String(length=256), nullable=True),
        sa.Column("external_url", sa.String(length=1024), nullable=True),
        sa.Column("receipt_verified", sa.Boolean(), nullable=True),
        sa.Column("provider_log_id", sa.String(length=128), nullable=True),
        sa.Column("error_detail", sa.Text(), nullable=True),
        _ts("created_at"),
        _ts("updated_at"),
        _ts("dispatched_at", nullable=True),
        _ts("completed_at", nullable=True),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"],
                                name=op.f("fk_tool_execution_workspace_id_workspace")),
        sa.ForeignKeyConstraint(["artifact_id"], ["artifact.id"],
                                name=op.f("fk_tool_execution_artifact_id_artifact")),
        sa.ForeignKeyConstraint(["artifact_version_id"], ["artifact_version.id"],
                                name=op.f("fk_tool_execution_artifact_version_id_artifact_version")),
        sa.ForeignKeyConstraint(["approval_id"], ["approval.id"],
                                name=op.f("fk_tool_execution_approval_id_approval")),
        sa.ForeignKeyConstraint(["screenshot_id"], ["screenshot.id"],
                                name=op.f("fk_tool_execution_screenshot_id_screenshot")),
        sa.ForeignKeyConstraint(["connection_id"], ["tool_connection.id"],
                                name=op.f("fk_tool_execution_connection_id_tool_connection")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tool_execution")),
        sa.UniqueConstraint("artifact_id", "action_index", "attempt", name="tool_execution_action_attempt"),
    )
    with op.batch_alter_table("tool_execution", schema=None) as b:
        b.create_index("ix_tool_execution_workspace_id", ["workspace_id"], unique=False)
        b.create_index("ix_tool_execution_artifact_id", ["artifact_id"], unique=False)
        b.create_index("ix_tool_execution_workspace_scope", ["workspace_id", "scope_key"], unique=False)
    # Structural duplicate rules (partial unique indexes; SQLite >= 3.8 and PostgreSQL):
    # at most one unresolved execution per scope, and one held delivery identity.
    unresolved = sa.text("status IN ('reserved', 'executing', 'unknown', 'rejected')")
    held = sa.text("status IN ('reserved', 'executing', 'succeeded', 'unknown', 'rejected')")
    op.create_index("uq_tool_execution_open_scope", "tool_execution", ["workspace_id", "scope_key"], unique=True,
                    sqlite_where=unresolved, postgresql_where=unresolved)
    op.create_index("uq_tool_execution_delivery", "tool_execution", ["workspace_id", "delivery_key"], unique=True,
                    sqlite_where=held, postgresql_where=held)


def downgrade() -> None:
    op.drop_index("uq_tool_execution_delivery", table_name="tool_execution")
    op.drop_index("uq_tool_execution_open_scope", table_name="tool_execution")
    with op.batch_alter_table("tool_execution", schema=None) as b:
        b.drop_index("ix_tool_execution_workspace_scope")
        b.drop_index("ix_tool_execution_artifact_id")
        b.drop_index("ix_tool_execution_workspace_id")
    op.drop_table("tool_execution")
    with op.batch_alter_table("tool_connection", schema=None) as b:
        b.drop_index("ix_tool_connection_workspace_toolkit")
        b.drop_index("ix_tool_connection_workspace_id")
    op.drop_table("tool_connection")
    with op.batch_alter_table("external_identity", schema=None) as b:
        b.drop_index("ix_external_identity_workspace_id")
    op.drop_table("external_identity")
