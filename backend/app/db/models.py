"""SQLAlchemy 2.x ORM models for Screenshot Graveyard.

Schema follows the approved design exactly. Every non-`workspace` table carries a
`workspace_id` FK and is indexed on it (Req 12.6, 9.9). Append-only history and
dedup are enforced by UNIQUE constraints (INV-5/INV-6 structural support, A3).

This module defines schema only. Business logic and invariant enforcement live in
the service layer (later tasks); there is no query/CRUD logic here.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy import event, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Workspace(Base):
    __tablename__ = "workspace"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Only sha256(token) is stored; the raw token lives only in the cookie.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # Batch 6B: opt-in automatic analysis -> routing -> draft preparation. Never
    # a consent: each screenshot still needs its own grant, checked at dispatch.
    auto_prepare: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class GlobalCounter(Base):
    """Deployment-wide usage counters (deployment readiness R5, R8).

    The ONE deliberately unscoped table: it holds no workspace data, only
    aggregate counts that must span all workspaces (a per-workspace quota alone
    cannot bound a public app, because anyone can mint a workspace). Keys:
    ``ai_calls:YYYY-MM-DD`` (UTC day) and ``storage_bytes``. Read and updated
    only through ``app.services.global_usage_service`` under a row lock.
    """

    __tablename__ = "global_counter"
    name: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class ContentBlob(Base):
    """Deduplicated original-bytes record; one row per unique content per workspace."""

    __tablename__ = "content_blob"
    __table_args__ = (
        UniqueConstraint("workspace_id", "sha256", name="content_blob_workspace_sha256"),
        Index("ix_content_blob_workspace_id", "workspace_id"),
        Index("ix_content_blob_workspace_sha256_lookup", "workspace_id", "sha256"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspace.id"), nullable=False
    )
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # Opaque content-addressed path on the private volume (never web-served).
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class Screenshot(Base):
    __tablename__ = "screenshot"
    __table_args__ = (
        Index("ix_screenshot_workspace_id", "workspace_id"),
        Index("ix_screenshot_workspace_state", "workspace_id", "state"),
    )

    # Stable Screenshot ID — never changes for the life of the record.
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspace.id"), nullable=False
    )
    content_blob_id: Mapped[int] = mapped_column(
        ForeignKey("content_blob.id"), nullable=False
    )
    original_filename: Mapped[str] = mapped_column(String(512), nullable=False)
    # state ∈ {active, archived}
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    is_duplicate_of: Mapped[int | None] = mapped_column(
        ForeignKey("screenshot.id"), nullable=True
    )
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class Artifact(Base):
    __tablename__ = "artifact"
    __table_args__ = (Index("ix_artifact_workspace_id", "workspace_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspace.id"), nullable=False
    )
    # kind ∈ {classification, epitaph, study_note}
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    # Pointer to the current version. Nullable until the first version exists.
    # use_alter avoids a circular-dependency cycle with artifact_version at DDL time.
    current_version_id: Mapped[int | None] = mapped_column(
        ForeignKey(
            "artifact_version.id",
            use_alter=True,
            name="fk_artifact_current_version_id_artifact_version",
        ),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class ArtifactVersion(Base):
    """Append-only (INSERT-only) version history. No UPDATE path to content_json."""

    __tablename__ = "artifact_version"
    __table_args__ = (
        UniqueConstraint(
            "artifact_id", "version_number", name="artifact_version_artifact_version"
        ),
        Index("ix_artifact_version_workspace_id", "workspace_id"),
        Index("ix_artifact_version_artifact_id", "artifact_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspace.id"), nullable=False
    )
    artifact_id: Mapped[int] = mapped_column(
        ForeignKey("artifact.id"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    # origin ∈ {ai_generate, ai_redo, manual_edit}
    origin: Mapped[str] = mapped_column(String(16), nullable=False)
    # Versioned payload (classification / epitaph / study_note). Stored as text
    # JSON for SQLite/Postgres portability; shape enforced by Pydantic at the
    # service boundary (later tasks).
    content_json: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class SourceReference(Base):
    """Provenance attached to the artifact so it survives every version/redo (INV-7)."""

    __tablename__ = "source_reference"
    __table_args__ = (
        UniqueConstraint(
            "artifact_id", "screenshot_id", name="source_reference_artifact_screenshot"
        ),
        Index("ix_source_reference_workspace_id", "workspace_id"),
        Index("ix_source_reference_artifact_id", "artifact_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspace.id"), nullable=False
    )
    artifact_id: Mapped[int] = mapped_column(
        ForeignKey("artifact.id"), nullable=False
    )
    screenshot_id: Mapped[int] = mapped_column(
        ForeignKey("screenshot.id"), nullable=False
    )


class ConsentRecord(Base):
    __tablename__ = "consent_record"
    __table_args__ = (
        UniqueConstraint(
            "workspace_id", "screenshot_id", name="consent_record_workspace_screenshot"
        ),
        Index("ix_consent_record_workspace_id", "workspace_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspace.id"), nullable=False
    )
    screenshot_id: Mapped[int] = mapped_column(
        ForeignKey("screenshot.id"), nullable=False
    )
    granted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    granted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Batch 6A (tasks.md 7.1): incremented on EVERY grant or withdrawal. An AI
    # dispatch records the version it was authorized against; a result is saved
    # only if the consent is still granted at that same version.
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    # Batch 6A: the AI provider this consent was given for (the user was shown
    # that provider's disclosure). A grant for the Fake AI ("nothing is sent")
    # never authorizes sending to a real provider. NULL = recorded before 6A.
    provider: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Batch 6A (P1-A): the revision of the disclosure the user was shown when
    # granting (app/ai/disclosure.py). A changed disclosure needs a fresh grant.
    disclosure_revision: Mapped[str | None] = mapped_column(String(64), nullable=True)


class AIDispatch(Base):
    """One authorized hand-off of ONE screenshot's original bytes to the AI adapter.

    Batch 6A (tasks.md 7.1, design D). A row is written, under the workspace
    write lock and in the same short transaction that re-reads consent, BEFORE
    the adapter is called; consent changes take the same lock, so the two are
    totally ordered per workspace. From the moment a row commits, the request is
    treated as possibly sent and cannot be recalled. ``UNIQUE(operation_id,
    screenshot_id)`` makes a duplicate worker for the same operation unable to
    dispatch twice.

    ``state``: ``dispatched`` (may have been sent; still running),
    ``completed`` (its result was saved, consent unchanged), ``discarded`` (the
    worker finished without saving a result) or ``interrupted`` (stale-pending
    recovery failed the operation: the request may have been sent, its outcome
    is unknown and nothing was saved). No state ever claims "not sent".
    """

    __tablename__ = "ai_dispatch"
    __table_args__ = (
        UniqueConstraint("operation_id", "screenshot_id", name="ai_dispatch_operation_screenshot"),
        Index("ix_ai_dispatch_workspace_id", "workspace_id"),
        Index("ix_ai_dispatch_screenshot_state", "screenshot_id", "state"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspace.id"), nullable=False)
    operation_id: Mapped[int] = mapped_column(ForeignKey("operation.id"), nullable=False)
    screenshot_id: Mapped[int] = mapped_column(ForeignKey("screenshot.id"), nullable=False)
    consent_version: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    dispatched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Operation(Base):
    __tablename__ = "operation"
    __table_args__ = (
        Index("ix_operation_workspace_id", "workspace_id"),
        Index("ix_operation_workspace_status", "workspace_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(
        ForeignKey("workspace.id"), nullable=False
    )
    # kind ∈ {classify, study_note, restore, delivery(P1)}
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    # status ∈ {pending, successful, failed, uncertain}
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    artifact_id: Mapped[int | None] = mapped_column(
        ForeignKey("artifact.id"), nullable=True
    )
    # Idempotency key for external writes (P1); unused stub in P0.
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error_detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )


class Approval(Base):
    """Approval ledger (Batch 5B): one INSERT-only record per approved version.

    Binds the workspace (the only actor identity this app has: there are no
    user accounts), the artifact and the exact immutable ``artifact_version``.
    ``version_number`` is informational. ``content_sha256`` is the SHA-256 of
    the approved version's stored ``content_json``, so a later reader can prove
    the approved bytes are unchanged. Approval never changes, replaces or adds a
    version, and records nothing about delivery. ``UNIQUE(artifact_version_id)``
    makes repeated or concurrent approvals of one version idempotent.
    """

    __tablename__ = "approval"
    __table_args__ = (
        UniqueConstraint("artifact_version_id", name="approval_artifact_version"),
        Index("ix_approval_workspace_id", "workspace_id"),
        Index("ix_approval_artifact_id", "artifact_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    workspace_id: Mapped[int] = mapped_column(ForeignKey("workspace.id"), nullable=False)
    artifact_id: Mapped[int] = mapped_column(ForeignKey("artifact.id"), nullable=False)
    artifact_version_id: Mapped[int] = mapped_column(
        ForeignKey("artifact_version.id"), nullable=False
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    # JSON list of fields whose uncertainty the user explicitly acknowledged.
    acknowledged_uncertain_json: Mapped[str] = mapped_column(Text, nullable=False)
    # JSON list of fields whose value came from AI and was not changed by the user.
    ai_origin_fields_json: Mapped[str] = mapped_column(Text, nullable=False)
    approved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, nullable=False
    )


class AppendOnlyViolationError(Exception):
    """Raised on any attempt to UPDATE or DELETE a retained artifact version."""


@event.listens_for(ArtifactVersion, "before_update")
def _forbid_version_update(mapper, connection, target) -> None:  # noqa: ANN001
    # INV-5/INV-6: a retained version is immutable. Edits and redos INSERT a new
    # version; there is deliberately no UPDATE path to content_json (or any other
    # column) of an existing row. This guards ORM flushes; the service layer and a
    # source-scan test guard against bulk UPDATE statements that bypass the ORM.
    raise AppendOnlyViolationError("artifact versions are append-only")


@event.listens_for(ArtifactVersion, "before_delete")
def _forbid_version_delete(mapper, connection, target) -> None:  # noqa: ANN001
    raise AppendOnlyViolationError("artifact versions are never deleted")


@event.listens_for(Approval, "before_update")
def _forbid_approval_update(mapper, connection, target) -> None:  # noqa: ANN001
    # The approval ledger is history: a record is never changed.
    raise AppendOnlyViolationError("approvals are append-only")


@event.listens_for(Approval, "before_delete")
def _forbid_approval_delete(mapper, connection, target) -> None:  # noqa: ANN001
    raise AppendOnlyViolationError("approvals are never deleted")
