"""approval ledger (Batch 5B)

Adds the INSERT-only ``approval`` table: one record per approved immutable
artifact version. Additive only; no existing table or row is changed.

Revision ID: b5a1c0de0001
Revises: 404866447fd9
Create Date: 2026-11-25 09:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "b5a1c0de0001"
down_revision: Union[str, Sequence[str], None] = "404866447fd9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "approval",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.Integer(), nullable=False),
        sa.Column("artifact_id", sa.Integer(), nullable=False),
        sa.Column("artifact_version_id", sa.Integer(), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("acknowledged_uncertain_json", sa.Text(), nullable=False),
        sa.Column("ai_origin_fields_json", sa.Text(), nullable=False),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"], name=op.f("fk_approval_workspace_id_workspace")),
        sa.ForeignKeyConstraint(["artifact_id"], ["artifact.id"], name=op.f("fk_approval_artifact_id_artifact")),
        sa.ForeignKeyConstraint(
            ["artifact_version_id"], ["artifact_version.id"],
            name=op.f("fk_approval_artifact_version_id_artifact_version"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_approval")),
        sa.UniqueConstraint("artifact_version_id", name="approval_artifact_version"),
    )
    with op.batch_alter_table("approval", schema=None) as batch_op:
        batch_op.create_index("ix_approval_workspace_id", ["workspace_id"], unique=False)
        batch_op.create_index("ix_approval_artifact_id", ["artifact_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("approval", schema=None) as batch_op:
        batch_op.drop_index("ix_approval_artifact_id")
        batch_op.drop_index("ix_approval_workspace_id")
    op.drop_table("approval")
