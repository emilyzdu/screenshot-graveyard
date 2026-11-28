"""Global usage counters (deployment foundation)

Adds ``global_counter``: deployment-wide counts for the global daily AI-request
quota and the global stored-bytes limit. The storage counter starts at the
total size of the content already stored, so existing screenshots are counted
(never deleted or rewritten). Additive only.

Revision ID: e7c2a9b00001
Revises: d6b1a7e00001
Create Date: 2026-11-27 12:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "e7c2a9b00001"
down_revision: Union[str, Sequence[str], None] = "d6b1a7e00001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "global_counter",
        sa.Column("name", sa.String(length=64), primary_key=True),
        sa.Column("value", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.current_timestamp()),
    )
    op.execute(
        "INSERT INTO global_counter (name, value) "
        "SELECT 'storage_bytes', COALESCE(SUM(byte_size), 0) FROM content_blob"
    )


def downgrade() -> None:
    op.drop_table("global_counter")
