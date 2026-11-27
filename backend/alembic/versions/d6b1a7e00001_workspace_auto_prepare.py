"""Workspace auto-preparation preference (Batch 6B)

Adds ``workspace.auto_prepare`` (existing rows start at false: automation is
strictly opt-in). Additive only. It never authorizes AI processing by itself:
every screenshot still needs its own provider- and disclosure-bound consent,
re-checked at each dispatch.

Revision ID: d6b1a7e00001
Revises: c6a1d15a0001
Create Date: 2026-11-27 09:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "d6b1a7e00001"
down_revision: Union[str, Sequence[str], None] = "c6a1d15a0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("workspace", schema=None) as batch_op:
        batch_op.add_column(sa.Column("auto_prepare", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("workspace", schema=None) as batch_op:
        batch_op.drop_column("auto_prepare")
