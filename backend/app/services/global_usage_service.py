"""Deployment-wide usage limits (deployment readiness R5, R8).

Per-workspace quotas cannot bound a public app on their own: anyone can mint a
new workspace. This service enforces two limits across ALL workspaces:

* a daily AI-request quota (``MAX_AI_CALLS_PER_DAY``): every new AI operation
  (each is at most one provider request) reserves one unit of today's UTC
  budget in the SAME transaction that creates the operation; and
* a stored-bytes limit (``MAX_TOTAL_STORAGE_BYTES``) for new original content.

Both counters live in the ``global_counter`` table, so they survive restarts
and redeploys. A reservation locks the counter row (``SELECT ... FOR UPDATE``
on PostgreSQL; on SQLite the caller already holds the database write lock via
``WorkspaceRepository.lock_workspace``), checks, and increments it; the
caller's commit makes the reservation and the new row visible together, and a
rollback releases both. Lock order is always "workspace row, then counter row",
so two workspaces can never deadlock on each other.

This is the one deliberate exception to "every query is workspace-scoped": the
table holds aggregate counts only, never workspace data.

The AI quota is an APPLICATION-SIDE REQUEST QUOTA, not a verified financial
cap. The hard spending cap is the provider account's own limit.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import models

STORAGE_KEY = "storage_bytes"


class GlobalLimitError(Exception):
    """A deployment-wide limit was reached (generic message only)."""


class GlobalAIBudgetExceededError(GlobalLimitError):
    pass


class GlobalStorageLimitError(GlobalLimitError):
    pass


def ai_key(now: datetime | None = None) -> str:
    moment = now or datetime.now(timezone.utc)
    return f"ai_calls:{moment.astimezone(timezone.utc).date().isoformat()}"


class GlobalUsageService:
    def __init__(self, session: Session) -> None:
        self._session = session

    def _insert_if_missing(self, name: str) -> None:
        dialect = self._session.get_bind().dialect.name
        if dialect == "postgresql":
            from sqlalchemy.dialects.postgresql import insert
        elif dialect == "sqlite":
            from sqlalchemy.dialects.sqlite import insert
        else:  # pragma: no cover - only SQLite and PostgreSQL are supported
            raise RuntimeError("unsupported database for global counters")
        self._session.execute(
            insert(models.GlobalCounter)
            .values(name=name, value=0)
            .on_conflict_do_nothing(index_elements=["name"])
        )

    def _locked(self, name: str) -> models.GlobalCounter:
        """The counter row, created if missing and locked for this transaction."""
        self._insert_if_missing(name)
        stmt = (
            select(models.GlobalCounter)
            .where(models.GlobalCounter.name == name)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return self._session.scalars(stmt).one()

    def _read(self, name: str) -> int:
        row = self._session.scalars(
            select(models.GlobalCounter)
            .where(models.GlobalCounter.name == name)
            .execution_options(populate_existing=True)
        ).one_or_none()
        return int(row.value) if row is not None else 0

    # -- AI requests
    def reserve_ai_call(self, limit: int, *, now: datetime | None = None) -> None:
        """Reserve one AI request from today's global quota, or raise. Flushes only."""
        row = self._locked(ai_key(now))
        if row.value + 1 > limit:
            raise GlobalAIBudgetExceededError("global AI request quota reached")
        row.value = row.value + 1
        self._session.flush()

    def ai_calls_today(self, *, now: datetime | None = None) -> int:
        return self._read(ai_key(now))

    # -- storage
    def storage_used(self) -> int:
        """Unlocked read for an early, non-authoritative check before bytes are written."""
        return self._read(STORAGE_KEY)

    def reserve_storage(self, nbytes: int, limit: int, *, free_bytes, min_free: int) -> None:
        """Reserve physical capacity for bytes about to be written, or raise.

        Called BEFORE the bytes are written, under the counter row lock, so two
        concurrent reservations can never together exceed ``limit``. The
        free-space floor is checked here too (``free_bytes`` is measured while
        the caller holds the process-wide allocation lock, so no other upload
        of this process is writing at the same time). The reservation stays
        counted whether or not the later metadata transaction succeeds: the
        written bytes are retained (write-once, never deleted), so they must
        stay counted. Flushes only; the caller commits it on its own.
        """
        if nbytes < 0:
            raise ValueError("nbytes must not be negative")
        row = self._locked(STORAGE_KEY)
        if row.value + nbytes > limit:
            raise GlobalStorageLimitError("global storage limit reached")
        if free_bytes - nbytes < min_free:
            raise GlobalStorageLimitError("storage volume free-space floor reached")
        row.value = row.value + nbytes
        self._session.flush()

    def reconcile_storage(self, physical_bytes: int) -> tuple[int, int]:
        """Set the counter to the measured physical bytes; returns (before, after).

        Run only while no upload can be in progress (the start script runs it
        before the server starts). It corrects reservations whose write never
        happened (a crash between reservation and write) and counts files no
        reservation covered (for example content stored before this counter
        existed). It never touches files. Flushes only.
        """
        row = self._locked(STORAGE_KEY)
        before = int(row.value)
        row.value = int(physical_bytes)
        self._session.flush()
        return before, int(physical_bytes)
