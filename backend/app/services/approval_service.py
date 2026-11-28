"""Version-specific approval of Notes and Calendar drafts (Batch 5B).

An approval is a durable ledger record binding the workspace (the only actor
identity this app has: there are no user accounts), an artifact and one exact
immutable ``artifact_version``. Approval never changes, replaces or adds a
version, calls no AI adapter and sends nothing anywhere: approval and delivery
are separate actions, and there is no delivery yet.

Rules, all enforced here (the client's view is never authoritative):

* Only the CURRENT version can be approved, checked under the workspace write
  lock with a fresh artifact read. A request for an older version is a
  version conflict, unless that exact version is already approved, in which
  case the existing record is returned (an idempotent retry, nothing written).
* The version must read back through the validated draft services: schema,
  authoritative source references and a complete, recognised edit history.
  Corrupt or inconsistent data is never approved.
* Every source screenshot must be active (Crypt drafts are read-only).
* Calendar drafts must be complete enough to become an event (title, start and
  end dates, all-day known; for a timed event start/end times and an IANA time
  zone). Nothing is filled in for the user.
* Uncertainty is never treated as certainty: every uncertain field (Calendar)
  or a non-empty "Uncertain" section (Notes) must be explicitly acknowledged,
  and the acknowledgement is stored with the approval.
* One approval per version (``UNIQUE(artifact_version_id)``); repeated and
  concurrent requests return the same record. The response is built before
  commit, so nothing that can fail runs after the write is durable.
* A newer version never inherits an older version's approval.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.db import models
from app.db.repository import CrossWorkspaceError, WorkspaceRepository
from app.services.draft_versioning import (
    DraftSourceArchivedError,
    DraftSourceMissingError,
    DraftVersionConflictError,
    require_sources_active,
)
from app.ai.schemas import EVENT_DRAFT_FIELDS
from app.services.event_draft_artifact_service import (
    EventDraftArtifactService,
    EventDraftNotFoundError,
    EventDraftUnavailableError,
)
from app.services import action_plan_service as _plans
from app.services.study_note_artifact_service import (
    NOTE_FIELDS,
    StudyNoteArtifactNotFoundError,
    StudyNoteArtifactService,
    StudyNoteArtifactUnavailableError,
)

KIND_STUDY_NOTE = "study_note"
KIND_EVENT_DRAFT = "event_draft"
# External tools: an AI action plan is approved like a draft (exact version +
# content SHA-256). Approval is not execution: running an approved action is a
# separate, explicitly authorized request (tool_execution_service).
KIND_ACTION_PLAN = _plans.KIND_ACTION_PLAN
APPROVABLE_KINDS = frozenset({KIND_STUDY_NOTE, KIND_EVENT_DRAFT, KIND_ACTION_PLAN})
_AI_ORIGINS = frozenset({"ai_generate", "ai_redo"})
_FIELDS_BY_KIND = {
    KIND_STUDY_NOTE: frozenset(NOTE_FIELDS),
    KIND_EVENT_DRAFT: frozenset(EVENT_DRAFT_FIELDS),
    KIND_ACTION_PLAN: frozenset(_plans.PLAN_FIELDS) | _plans.ACK_FIELDS,
}
# Status is assembled from several reads; retry when the pointer moved meanwhile.
_STATUS_ATTEMPTS = 3

_CALENDAR_REQUIRED = (
    ("title", "Add a title."),
    ("start_date", "Add a start date."),
    ("end_date", "Add an end date."),
    ("all_day", "Say whether this is an all-day event."),
)
_CALENDAR_REQUIRED_WHEN_TIMED = (
    ("start_time", "Add a start time."),
    ("end_time", "Add an end time."),
    ("time_zone", "Add a time zone."),
)


class ApprovalError(Exception):
    """Base error for approval requests (safe, non-private messages)."""


class ApprovalNotFoundError(ApprovalError):
    """Missing, foreign, wrong-kind artifact, or a version of another artifact."""


class ApprovalUnavailableError(ApprovalError):
    """Database unavailable, or stored data inconsistent (never approved)."""


class ApprovalNotEligibleError(ApprovalError):
    def __init__(self, reasons: list[dict]) -> None:
        super().__init__("this version cannot be approved yet")
        self.reasons = reasons


class ApprovalAcknowledgementError(ApprovalError):
    def __init__(self, required: list[str]) -> None:
        super().__init__("uncertain content must be acknowledged")
        self.required = required


@dataclass(frozen=True)
class Eligibility:
    eligible: bool
    reasons: list[dict]
    # Fields whose uncertainty must be acknowledged to approve.
    uncertain: list[str]
    # Fields with a value that came from AI and that the user has not changed.
    ai_origin_fields: list[str]


@dataclass(frozen=True)
class ApprovalRecord:
    approval_id: int
    artifact_id: int
    version_id: int
    version_number: int
    approved_at: str
    acknowledged_uncertain: list[str]
    ai_origin_fields: list[str]
    content_sha256: str


@dataclass(frozen=True)
class ApprovalStatus:
    artifact_id: int
    kind: str
    current_version_id: int
    current_version_number: int
    # "current_approved" | "older_approved" | "never_approved"
    status: str
    approvals: list[ApprovalRecord]
    eligibility: Eligibility


def _sha256(content_json: str) -> str:
    return hashlib.sha256(content_json.encode("utf-8")).hexdigest()


def _iso(dt) -> str:
    # SQLite returns naive datetimes; values are always written in UTC.
    return dt.isoformat() if dt.tzinfo else dt.isoformat() + "+00:00"


def _calendar_eligibility(view) -> tuple[list[dict], list[str], list[str]]:
    c = view.content
    reasons = [
        {"field": f, "code": "missing", "message": m}
        for f, m in _CALENDAR_REQUIRED
        if getattr(c, f) is None
    ]
    if c.all_day is not True:
        reasons += [
            {"field": f, "code": "missing", "message": m}
            for f, m in _CALENDAR_REQUIRED_WHEN_TIMED
            if getattr(c, f) is None
        ]
    origins = view.field_origins or {}
    ai_fields = sorted(
        f for f, o in origins.items() if o.get("origin") in _AI_ORIGINS and getattr(c, f, None) is not None
    )
    return reasons, sorted(c.uncertain_fields), ai_fields


def _notes_eligibility(view) -> tuple[list[dict], list[str], list[str]]:
    c = view.content
    origins = view.field_origins or {}
    ai_fields = sorted(
        f for f in NOTE_FIELDS
        if origins.get(f, {}).get("origin") in _AI_ORIGINS and getattr(c, f) not in ("", [], None)
    )
    uncertain = ["uncertain_content"] if c.uncertain_content else []
    return [], uncertain, ai_fields


def _eligibility_for(kind: str, view) -> tuple[list[dict], list[str], list[str]]:
    if kind == KIND_STUDY_NOTE:
        return _notes_eligibility(view)
    if kind == KIND_ACTION_PLAN:
        return _plans.plan_eligibility(view)
    return _calendar_eligibility(view)


class ApprovalService:
    def __init__(self, session: Session, workspace_id: int) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        self._session = session
        self._repo = WorkspaceRepository(session, workspace_id)
        self._notes = StudyNoteArtifactService(session, workspace_id)
        self._events = EventDraftArtifactService(session, workspace_id)
        self._plans = _plans.ActionPlanService(session, workspace_id)

    # ------------------------------------------------------------------ reads
    def status(self, artifact_id: int) -> ApprovalStatus:
        """Approval history and the CURRENT version's eligibility. Read-only.

        Coherence without holding a lock: the current-version pointer is read
        before and after the version and the ledger are read. The pointer only
        ever moves forward to a NEW version, so equal reads mean it did not
        move in between, and the ledger read (insert-only) is a consistent
        companion to that version. This holds under SQLite and under
        PostgreSQL READ COMMITTED alike (each statement sees committed data;
        no snapshot is assumed). If it keeps moving, the answer is
        "unavailable", never a contradictory status.
        """
        try:
            for _attempt in range(_STATUS_ATTEMPTS):
                result = self._status_once(artifact_id)
                if result is not None:
                    return result
            raise ApprovalUnavailableError("approval status kept changing")
        except CrossWorkspaceError as exc:
            raise ApprovalNotFoundError("not found") from exc
        except SQLAlchemyError as exc:
            raise ApprovalUnavailableError("approval service unavailable") from exc

    def _status_once(self, artifact_id: int) -> ApprovalStatus | None:
        """One coherent attempt, or None if the current version moved during it."""
        self._session.expire_all()  # never build from objects cached by an earlier attempt
        if not self._valid_id(artifact_id):
            raise ApprovalNotFoundError("not found")
        before = self._repo.read_current_version_id(artifact_id)
        artifact = self._artifact(self._repo.get_artifact(artifact_id))
        view = self._read_view(artifact)
        rows = self._repo.list_approvals(artifact.id)
        after = self._repo.read_current_version_id(artifact.id)
        if not (before == view.version_id == after) or any(r.version_number > view.version_number for r in rows):
            return None
        approvals = [self._record(r, artifact) for r in rows]
        eligibility = self._eligibility(artifact.kind, view, check_sources=True)
        if any(a.version_id == view.version_id for a in approvals):
            state = "current_approved"
        elif approvals:
            state = "older_approved"
        else:
            state = "never_approved"
        return ApprovalStatus(
            artifact_id=artifact.id,
            kind=artifact.kind,
            current_version_id=view.version_id,
            current_version_number=view.version_number,
            status=state,
            approvals=approvals,
            eligibility=eligibility,
        )

    # ------------------------------------------------------------------ write
    def approve(self, artifact_id: int, version_id: int, acknowledged: list[str]) -> tuple[ApprovalRecord, str]:
        """Approve ``version_id`` if it is the current, eligible version.

        Returns ``(record, "created" | "existing")``. Nothing is written on any
        error; the response is built before commit.
        """
        try:
            if not self._valid_id(artifact_id) or not self._valid_id(version_id):
                raise ApprovalNotFoundError("not found")
            if self._repo.lock_workspace() is None:
                raise ApprovalNotFoundError("not found")
            artifact = self._artifact(self._repo.get_artifact_locked(artifact_id))
            version = self._repo.get_artifact_version(version_id)
            if version is None or version.artifact_id != artifact.id:
                raise ApprovalNotFoundError("not found")

            existing = self._repo.get_approval_for_version(version.id)
            if existing is not None:
                record = self._record(existing, artifact)  # fully re-verified before it is returned
                self._session.rollback()  # release the lock; nothing changed
                return record, "existing"

            current = (
                self._repo.get_artifact_version(artifact.current_version_id)
                if artifact.current_version_id is not None
                else None
            )
            if current is None:
                raise ApprovalUnavailableError("approval service unavailable")
            if version.id != current.id:
                raise DraftVersionConflictError(current.id, current.version_number)

            view = self._read_view(artifact)  # validates the (current) version, sources and history
            self._require_sources_active_locked(view.source_screenshot_ids)
            eligibility = self._eligibility(artifact.kind, view, check_sources=False)
            if not eligibility.eligible:
                raise ApprovalNotEligibleError(eligibility.reasons)
            if sorted(set(acknowledged)) != eligibility.uncertain or len(set(acknowledged)) != len(acknowledged):
                raise ApprovalAcknowledgementError(eligibility.uncertain)

            try:
                with self._session.begin_nested():
                    row = self._repo.add_approval(
                        artifact_id=artifact.id,
                        artifact_version_id=version.id,
                        version_number=version.version_number,
                        content_sha256=_sha256(version.content_json),
                        acknowledged_uncertain_json=json.dumps(eligibility.uncertain),
                        ai_origin_fields_json=json.dumps(eligibility.ai_origin_fields),
                    )
            except IntegrityError:
                # Another request recorded it first: that record is the answer.
                existing = self._repo.get_approval_for_version(version.id)
                if existing is None:
                    raise
                record = self._record(existing, artifact)
                self._session.rollback()
                return record, "existing"
            record = self._record(row, artifact)  # built BEFORE commit
            self._session.commit()
            return record, "created"
        except (ApprovalError, DraftVersionConflictError, DraftSourceArchivedError):
            self._session.rollback()
            raise
        except DraftSourceMissingError as exc:
            self._session.rollback()
            raise ApprovalUnavailableError("approval service unavailable") from exc
        except CrossWorkspaceError as exc:
            self._session.rollback()
            raise ApprovalNotFoundError("not found") from exc
        except Exception as exc:
            self._session.rollback()
            raise ApprovalUnavailableError("approval service unavailable") from exc

    # -------------------------------------------------------------- internals
    @staticmethod
    def _valid_id(value) -> bool:
        return type(value) is int and value > 0

    @staticmethod
    def _artifact(artifact):
        if artifact is None or artifact.kind not in APPROVABLE_KINDS:
            raise ApprovalNotFoundError("not found")
        return artifact

    def _require_sources_active_locked(self, source_ids: list[int]) -> None:
        """Final NEW-approval source check, from the locked fresh screenshot read.

        Same pattern as Prepare (Batch 4A): after the workspace lock, each source
        row is read with FOR UPDATE + populate_existing. On PostgreSQL this waits
        for an in-flight Safe Burial and then sees its committed result; on
        SQLite the workspace lock already holds the database write lock. Lock
        order is workspace row -> screenshot rows, as everywhere else.
        """
        if not source_ids:
            raise ApprovalUnavailableError("approval service unavailable")
        for sid in source_ids:
            shot = self._repo.get_screenshot_locked(sid)
            if shot is None:
                raise ApprovalUnavailableError("approval service unavailable")
            if shot.state != "active":
                raise DraftSourceArchivedError("source screenshot is archived")

    def _read_view(self, artifact, version_id: int | None = None):
        """The current version through the validated draft service (sources, schema, history)."""
        try:
            if artifact.kind == KIND_STUDY_NOTE:
                return self._notes.get_version(artifact.id, version_id)
            if artifact.kind == KIND_ACTION_PLAN:
                return self._plans.get_version(artifact.id, version_id)
            return self._events.get_version(artifact.id, version_id)
        except (StudyNoteArtifactNotFoundError, EventDraftNotFoundError, _plans.ActionPlanNotFoundError) as exc:
            raise ApprovalNotFoundError("not found") from exc
        except (StudyNoteArtifactUnavailableError, EventDraftUnavailableError, _plans.ActionPlanUnavailableError) as exc:
            raise ApprovalUnavailableError("approval service unavailable") from exc

    def _eligibility(self, kind: str, view, *, check_sources: bool) -> Eligibility:
        reasons, uncertain, ai_fields = _eligibility_for(kind, view)
        if view.field_origins is None:
            reasons = [{
                "field": None, "code": "history_unverified",
                "message": "This version's edit history could not be verified, so it cannot be approved.",
            }] + reasons
        if check_sources:
            try:
                require_sources_active(self._repo, view.source_screenshot_ids)
            except DraftSourceArchivedError:
                reasons = [{
                    "field": None, "code": "screenshot_archived",
                    "message": "The source screenshot is in The Crypt. Resurrect it to approve this draft.",
                }] + reasons
            except DraftSourceMissingError as exc:
                raise ApprovalUnavailableError("approval service unavailable") from exc
        return Eligibility(eligible=not reasons, reasons=reasons, uncertain=uncertain, ai_origin_fields=ai_fields)

    def _record(self, row: models.Approval, artifact) -> ApprovalRecord:
        """A ledger record, fully verified before it is trusted (reads and replays alike).

        * association: the record belongs to this artifact, and its version is a
          version of this artifact with the recorded number;
        * the approved version still reads back through the validated draft
          service (schema + authoritative, workspace-owned sources) - an
          archived source is fine: historical approvals stay readable;
        * fingerprint: SHA-256 of the stored bytes equals the recorded one;
        * metadata: both lists are JSON lists of distinct field names of this
          draft kind, and the acknowledgements are exactly the uncertainty of
          the approved version itself (so historical approvals are judged
          against their own version, never the current one).
        Anything else is the generic unavailable error; nothing is repaired.
        """
        version = self._repo.get_artifact_version(row.artifact_version_id)
        if (
            row.artifact_id != artifact.id
            or version is None
            or version.artifact_id != artifact.id
            or version.version_number != row.version_number
            or _sha256(version.content_json) != row.content_sha256
        ):
            raise ApprovalUnavailableError("approval service unavailable")
        try:
            view = self._read_view(artifact, version.id)
        except ApprovalNotFoundError as exc:
            raise ApprovalUnavailableError("approval service unavailable") from exc
        allowed = _FIELDS_BY_KIND[artifact.kind]
        acknowledged = self._field_list(row.acknowledged_uncertain_json, allowed)
        ai_fields = self._field_list(row.ai_origin_fields_json, allowed)
        # The acknowledgement set must be exactly what THAT immutable version
        # required (same rule as approve()): nothing missing, extra or swapped.
        _, required, _ = _eligibility_for(artifact.kind, view)
        if sorted(acknowledged) != required:
            raise ApprovalUnavailableError("approval service unavailable")
        return ApprovalRecord(
            approval_id=row.id,
            artifact_id=row.artifact_id,
            version_id=row.artifact_version_id,
            version_number=row.version_number,
            approved_at=_iso(row.approved_at),
            acknowledged_uncertain=acknowledged,
            ai_origin_fields=ai_fields,
            content_sha256=row.content_sha256,
        )

    @staticmethod
    def _field_list(raw: str, allowed: frozenset[str]) -> list[str]:
        try:
            value = json.loads(raw)
        except (TypeError, ValueError) as exc:
            raise ApprovalUnavailableError("approval service unavailable") from exc
        if (
            not isinstance(value, list)
            or not all(isinstance(f, str) and f in allowed for f in value)
            or len(set(value)) != len(value)
        ):
            raise ApprovalUnavailableError("approval service unavailable")
        return value
