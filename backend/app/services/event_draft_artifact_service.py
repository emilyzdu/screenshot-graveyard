"""Persisted calendar event drafts: reads (Batch 4B) and manual edits (Batch 5A).

Workspace-scoped reads of an ``event_draft`` artifact's retained versions and
its source screenshots. A missing, foreign or other-kind artifact is the same
not-found error (no existence disclosure).

Manual edits (Batch 5A) append a new ``manual_edit`` version; no version is
ever updated or deleted, and no AI adapter is involved. The client sends only
the editable event fields plus the fields it explicitly flags as uncertain; the
server re-derives ``missing_fields`` and ``uncertain_fields``, attaches the
authoritative source reference, and re-runs the strict ``EventDraftResult``
validation (including the DST gap/ambiguity checks). There is no approve,
delete or delivery path here.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, StrictBool, ValidationError, field_validator
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.ai.schemas import EVENT_DRAFT_FIELDS, EventDraftResult
from app.db.repository import CrossWorkspaceError, WorkspaceRepository
from app.services.artifact_version_service import (
    ORIGIN_MANUAL_EDIT,
    ArtifactVersionService,
    VersionConflictError,
)
from app.services.draft_versioning import (
    DraftSourceArchivedError,
    DraftSourceMissingError,
    DraftVersionConflictError,
    field_origins,
    require_sources_active,
)
from app.services.event_draft_service import KIND_EVENT_DRAFT, event_draft_json

# Times and the zone do not apply to an all-day event, so they are never "missing" then.
_NOT_APPLICABLE_WHEN_ALL_DAY = frozenset({"start_time", "end_time", "time_zone"})


class EventDraftArtifactError(Exception):
    """Base error for event draft reads and edits."""


class EventDraftNotFoundError(EventDraftArtifactError):
    """Missing, foreign or not an event draft (identical, non-disclosing)."""


class EventDraftUnavailableError(EventDraftArtifactError):
    """Database unavailable, or stored content no longer validates."""


class EventDraftEditValidationError(EventDraftArtifactError):
    """The edited event does not validate. ``message``/``field`` are safe to show."""

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.field = field


class EventDraftEditContent(BaseModel):
    """The user-editable event fields. Every key is REQUIRED (``null`` = unknown),
    so an omitted key can never silently clear a value. References,
    ``missing_fields`` and ``uncertain_fields`` are not accepted from the client."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str | None
    start_date: str | None
    start_time: str | None
    end_date: str | None
    end_time: str | None
    all_day: StrictBool | None
    time_zone: str | None
    location: str | None
    description: str | None

    @field_validator("title", "start_date", "start_time", "end_date", "end_time", "time_zone", "location", "description")
    @classmethod
    def _blank_is_unknown(cls, v: str | None) -> str | None:
        return None if v is not None and v == "" else v


@dataclass(frozen=True)
class EventDraftVersion:
    artifact_id: int
    version_id: int
    version_number: int
    origin: str
    content: EventDraftResult
    source_screenshot_ids: list[int]
    # Per-field {origin, versionNumber} of the last change, or None if unknown.
    field_origins: dict[str, dict] | None = None


@dataclass(frozen=True)
class EventDraftEditOutcome:
    version: EventDraftVersion
    # created: a new version was inserted. replayed: the same edit already
    # produced the current version. unchanged: nothing differed from the base.
    result: str


_FORMAT_HINTS = {
    "start_date": "Enter the start date as YYYY-MM-DD.",
    "end_date": "Enter the end date as YYYY-MM-DD.",
    "start_time": "Enter the start time as HH:MM (24-hour).",
    "end_time": "Enter the end time as HH:MM (24-hour).",
}


# Model-level messages that do not start with the field they are about.
_FIELD_BY_MESSAGE = {"a time needs an explicit time zone": "time_zone"}


def _safe_message(error: dict) -> tuple[str, str | None]:
    """A user-facing message and field for the first validation error.

    Messages come from our own validators or a fixed format hint; pydantic's
    raw pattern text and the submitted value are never echoed back.
    """
    loc = error.get("loc") or ()
    field = str(loc[0]) if loc and str(loc[0]) in EVENT_DRAFT_FIELDS else None
    if error.get("type") == "string_pattern_mismatch" and field in _FORMAT_HINTS:
        return _FORMAT_HINTS[field], field
    message = str(error.get("msg", "Invalid event")).removeprefix("Value error, ")
    if field is None:
        head = message.split(" ", 1)[0]
        field = head if head in EVENT_DRAFT_FIELDS else _FIELD_BY_MESSAGE.get(message)
    return message, field


def _is_replay(base, current, same_as_current: bool) -> bool:
    """Evidence that THIS edit (same base, same result) produced the current version.

    A base-checked save always inserts the version right after its base and
    makes it current, so the save that produced ``current`` was based on
    ``current.version_number - 1``. A stale request with a different base is a
    conflict even when its content happens to equal the current version.
    """
    return (
        same_as_current
        and current.origin == ORIGIN_MANUAL_EDIT
        and current.version_number == base.version_number + 1
    )


class EventDraftArtifactService:
    def __init__(self, session: Session, workspace_id: int) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        self._session = session
        self._repo = WorkspaceRepository(session, workspace_id)
        self._versions = ArtifactVersionService(session, workspace_id)

    # ------------------------------------------------------------------ reads
    def get_version(self, artifact_id: int, version_id: int | None = None) -> EventDraftVersion:
        """A retained owned event draft version, defaulting to the current one."""
        try:
            artifact = self._event_draft(artifact_id)
            selected = artifact.current_version_id if version_id is None else version_id
            if selected is None:
                raise EventDraftNotFoundError("event draft not found")
            version = self._repo.get_artifact_version(selected)
            if version is None or version.artifact_id != artifact.id:
                raise EventDraftNotFoundError("event draft not found")
            return self._version(artifact, version)
        except CrossWorkspaceError as exc:
            raise EventDraftNotFoundError("event draft not found") from exc
        except SQLAlchemyError as exc:
            raise EventDraftUnavailableError("event draft service unavailable") from exc

    def list_versions(self, artifact_id: int) -> list[dict]:
        """All retained versions of an owned event draft, oldest first."""
        try:
            artifact = self._event_draft(artifact_id)
            versions = sorted(self._repo.list_artifact_versions(artifact.id), key=lambda v: v.version_number)
            return [
                {
                    "versionId": v.id,
                    "versionNumber": v.version_number,
                    "origin": v.origin,
                    "isCurrent": v.id == artifact.current_version_id,
                }
                for v in versions
            ]
        except CrossWorkspaceError as exc:
            raise EventDraftNotFoundError("event draft not found") from exc
        except SQLAlchemyError as exc:
            raise EventDraftUnavailableError("event draft service unavailable") from exc

    # ------------------------------------------------------------------ edits
    def save_edit(
        self,
        artifact_id: int,
        base_version_id: int,
        raw_content: object,
        raw_uncertain: object,
    ) -> EventDraftEditOutcome:
        """Append ONE manual version based on ``base_version_id``, atomically.

        Runs under the workspace write lock: the current-version check, the
        insert and the pointer move are one transaction. Stale base → conflict,
        unless this exact edit already produced the current version (see
        ``_is_replay``). The response is built BEFORE commit, so nothing that
        can fail runs after the write is durable; on any error nothing is written.
        """
        try:
            try:
                edit = EventDraftEditContent.model_validate(raw_content)
                flags = self._uncertain_flags(raw_uncertain)
            except (ValidationError, TypeError, ValueError) as exc:
                raise EventDraftEditValidationError("The edited event is not in the expected format.") from exc
            if self._repo.lock_workspace() is None:
                raise EventDraftNotFoundError("event draft not found")
            artifact = self._event_draft(artifact_id)
            if type(base_version_id) is not int or base_version_id <= 0:
                raise EventDraftNotFoundError("event draft not found")
            base = self._repo.get_artifact_version(base_version_id)
            current = self._repo.get_artifact_version(artifact.current_version_id) if artifact.current_version_id else None
            if base is None or base.artifact_id != artifact.id or current is None:
                raise EventDraftNotFoundError("event draft not found")
            current_content = self._parse(current.content_json)
            sources = self._consistent_sources(artifact.id, current_content)
            require_sources_active(self._repo, sources)
            stale = base.id != current.id
            try:
                candidate = self._candidate(self._parse(base.content_json), edit, flags, sources)
            except EventDraftEditValidationError:
                if stale:
                    raise DraftVersionConflictError(current.id, current.version_number)
                raise
            same_as_current = candidate.model_dump() == current_content.model_dump()
            if stale:
                if _is_replay(base, current, same_as_current):
                    outcome = EventDraftEditOutcome(self._version(artifact, current), "replayed")
                    self._session.rollback()  # release the lock; nothing changed
                    return outcome
                raise DraftVersionConflictError(current.id, current.version_number)
            if same_as_current:
                outcome = EventDraftEditOutcome(self._version(artifact, current), "unchanged")
                self._session.rollback()
                return outcome
            version = self._versions.append_version(artifact.id, event_draft_json(candidate), ORIGIN_MANUAL_EDIT)
            outcome = EventDraftEditOutcome(self._version(artifact, version), "created")  # before commit
            self._session.commit()
            return outcome
        except (EventDraftArtifactError, DraftVersionConflictError, DraftSourceArchivedError):
            self._session.rollback()
            raise
        except DraftSourceMissingError as exc:
            self._session.rollback()
            raise EventDraftUnavailableError("event draft service unavailable") from exc
        except CrossWorkspaceError as exc:
            self._session.rollback()
            raise EventDraftNotFoundError("event draft not found") from exc
        except (VersionConflictError, SQLAlchemyError) as exc:
            self._session.rollback()
            raise EventDraftUnavailableError("event draft service unavailable") from exc
        except Exception as exc:
            # Anything unexpected happens before commit (the response is built
            # first), so rolling back makes "not saved" the truth.
            self._session.rollback()
            raise EventDraftUnavailableError("event draft service unavailable") from exc

    @staticmethod
    def _uncertain_flags(raw: object) -> frozenset[str]:
        if raw is None:
            return frozenset()
        if not isinstance(raw, list) or any(f not in EVENT_DRAFT_FIELDS for f in raw) or len(set(raw)) != len(raw):
            raise ValueError("invalid uncertain fields")
        return frozenset(raw)

    @staticmethod
    def _candidate(
        base: EventDraftResult, edit: EventDraftEditContent, flags: frozenset[str], sources: list[int]
    ) -> EventDraftResult:
        """The new version's content, derived from the base and the explicit edit.

        * missing  = every applicable field that is still empty (nothing defaulted);
        * uncertain = fields the user explicitly flags, PLUS the base's uncertain
          fields the user did not change (an unchanged AI value never becomes
          certain just because something else was edited);
        * references = the authoritative source, never client-supplied.
        """
        values = edit.model_dump()
        all_day = values["all_day"] is True
        changed = {f for f in EVENT_DRAFT_FIELDS if values[f] != getattr(base, f)}
        missing = [
            f for f in EVENT_DRAFT_FIELDS
            if values[f] is None and not (all_day and f in _NOT_APPLICABLE_WHEN_ALL_DAY)
        ]
        uncertain = [
            f for f in EVENT_DRAFT_FIELDS
            if values[f] is not None and (f in flags or (f not in changed and f in base.uncertain_fields))
        ]
        try:
            return EventDraftResult.model_validate(
                {**values, "missing_fields": missing, "uncertain_fields": uncertain, "references": list(sources)}
            )
        except ValidationError as exc:
            raise EventDraftEditValidationError(*_safe_message(exc.errors()[0])) from exc

    # -------------------------------------------------------------- internals
    def _version(self, artifact, version) -> EventDraftVersion:
        content = self._parse(version.content_json)
        sources = self._consistent_sources(artifact.id, content)
        return EventDraftVersion(
            artifact_id=artifact.id,
            version_id=version.id,
            version_number=version.version_number,
            origin=version.origin,
            content=content,
            source_screenshot_ids=sources,
            field_origins=field_origins(
                self._repo.list_artifact_versions(artifact.id),
                version.version_number,
                EVENT_DRAFT_FIELDS,
                lambda raw: self._history_content(raw, sources),
            ),
        )

    def _history_content(self, raw: str, sources: list[int]) -> dict:
        """A historical payload for provenance: fully validated, same source. Raises otherwise."""
        content = self._parse(raw)
        if content.references != sources:
            raise EventDraftUnavailableError("event draft service unavailable")
        return content.model_dump()

    def _event_draft(self, artifact_id: int):
        if type(artifact_id) is not int or artifact_id <= 0:
            raise EventDraftNotFoundError("event draft not found")
        artifact = self._repo.get_artifact(artifact_id)
        if artifact is None or artifact.kind != KIND_EVENT_DRAFT:
            raise EventDraftNotFoundError("event draft not found")
        return artifact

    def _consistent_sources(self, artifact_id: int, content: EventDraftResult) -> list[int]:
        """The authoritative source, cross-checked against the stored payload.

        Batch 4B drafts come from exactly ONE screenshot. The workspace-scoped
        ``source_reference`` rows are the authority: there must be exactly one,
        its screenshot must belong to this workspace, and the payload's
        ``references`` must be exactly that one id. Anything else is
        inconsistent stored data, reported as the generic unavailable error
        without echoing any id or content.
        """
        sources = [ref.screenshot_id for ref in self._repo.list_source_references(artifact_id)]
        if len(sources) != 1 or content.references != sources:
            raise EventDraftUnavailableError("event draft service unavailable")
        if self._repo.get_screenshot(sources[0]) is None:  # foreign or missing screenshot
            raise EventDraftUnavailableError("event draft service unavailable")
        return sources

    @staticmethod
    def _parse(content_json: str) -> EventDraftResult:
        try:
            return EventDraftResult.model_validate(json.loads(content_json))
        except (json.JSONDecodeError, ValidationError, TypeError, ValueError) as exc:
            raise EventDraftUnavailableError("event draft service unavailable") from exc


__all__ = [
    "EventDraftArtifactService",
    "EventDraftEditContent",
    "EventDraftEditOutcome",
    "EventDraftEditValidationError",
    "EventDraftNotFoundError",
    "EventDraftUnavailableError",
    "EventDraftVersion",
]
