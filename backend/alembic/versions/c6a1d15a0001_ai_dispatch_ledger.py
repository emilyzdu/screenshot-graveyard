"""AI dispatch ledger and consent version (Batch 6A, tasks.md 7.1)

Adds ``consent_record.version`` (existing rows start at 0),
``consent_record.provider`` and ``consent_record.disclosure_revision``
(existing rows NULL: never valid for a real provider, so a real-provider
analysis needs a fresh, informed grant against the current disclosure) and the
``ai_dispatch`` table. Additive only: no existing row, original or artifact
version is changed.

Revision ID: c6a1d15a0001
Revises: b5a1c0de0001
Create Date: 2026-11-26 09:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "c6a1d15a0001"
down_revision: Union[str, Sequence[str], None] = "b5a1c0de0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("consent_record", schema=None) as batch_op:
        batch_op.add_column(sa.Column("version", sa.Integer(), nullable=False, server_default="0"))
        batch_op.add_column(sa.Column("provider", sa.String(length=16), nullable=True))
        batch_op.add_column(sa.Column("disclosure_revision", sa.String(length=64), nullable=True))
    op.create_table(
        "ai_dispatch",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("operation_id", sa.Integer(), nullable=False),
        sa.Column("screenshot_id", sa.Integer(), nullable=False),
        sa.Column("consent_version", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("dispatched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"], name=op.f("fk_ai_dispatch_workspace_id_workspace")),
        sa.ForeignKeyConstraint(["operation_id"], ["operation.id"], name=op.f("fk_ai_dispatch_operation_id_operation")),
        sa.ForeignKeyConstraint(["screenshot_id"], ["screenshot.id"], name=op.f("fk_ai_dispatch_screenshot_id_screenshot")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ai_dispatch")),
        sa.UniqueConstraint("operation_id", "screenshot_id", name="ai_dispatch_operation_screenshot"),
    )
    with op.batch_alter_table("ai_dispatch", schema=None) as batch_op:
        batch_op.create_index("ix_ai_dispatch_workspace_id", ["workspace_id"], unique=False)
        batch_op.create_index("ix_ai_dispatch_screenshot_state", ["screenshot_id", "state"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("ai_dispatch", schema=None) as batch_op:
        batch_op.drop_index("ix_ai_dispatch_screenshot_state")
        batch_op.drop_index("ix_ai_dispatch_workspace_id")
    op.drop_table("ai_dispatch")
    with op.batch_alter_table("consent_record", schema=None) as batch_op:
        batch_op.drop_column("disclosure_revision")
        batch_op.drop_column("provider")
        batch_op.drop_column("version")
