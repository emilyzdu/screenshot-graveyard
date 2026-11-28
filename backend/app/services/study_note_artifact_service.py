"""Append-only manual Study Note editing and export (Task 2.8).

This is deliberately a narrow companion to ``StudyNoteService``: it operates
only on an already-generated ``study_note`` artifact.  It never reads image
bytes, invokes an AI adapter, creates operations, or changes provenance.

The generic concurrent redo/versioning workflow is Task 3.1.  Task 2.8 still
needs safe manual edits, so this service uses the existing workspace lock and
the existing INSERT-only ``artifact_version`` table to atomically insert one
manual version and repoint ``current_version_id``.  Prior version rows and
source-reference rows are never updated.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.ai.schemas import StudyNoteResult
from app.db.repository import CrossWorkspaceError, WorkspaceRepository
from app.services.artifact_version_service import (
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

_KIND_STUDY_NOTE = "study_note"
_ORIGIN_MANUAL_EDIT = "manual_edit"
# Editable sections, in display order. ``references`` is provenance, not content.
NOTE_FIELDS: tuple[str, ...] = (
    "topic",
    "main_concepts",
    "extracted_code",
    "code_explanations",
    "pitfalls",
    "uncertain_content",
)


class StudyNoteArtifactError(Exception):
    """Base error with safe, non-private messages."""


class StudyNoteArtifactNotFoundError(StudyNoteArtifactError):
    """Missing, foreign, and wrong-kind artifacts are intentionally identical."""


class StudyNoteArtifactUnavailableError(StudyNoteArtifactError):
    """The database could not safely complete a read or write."""


class StudyNoteEditValidationError(StudyNoteArtifactError):
    """The client supplied malformed manual note content."""


class ManualStudyNoteContent(BaseModel):
    """Editable Study Note fields, excluding immutable source references.

    References are artifact-level provenance.  They are retained server-side on
    every manual version rather than accepted from a client that could replace
    or fabricate them.
    """

    model_config = ConfigDict(extra="forbid")

    topic: str = Field(min_length=1)
    main_concepts: list[str] = Field(default_factory=list)
    extracted_code: list[str] = Field(default_factory=list)
    code_explanations: list[str] = Field(default_factory=list)
    pitfalls: list[str] = Field(default_factory=list)
    uncertain_content: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class StudyNoteVersion:
    artifact_id: int
    version_id: int
    version_number: int
    origin: str
    content: StudyNoteResult
    source_screenshot_ids: list[int]
    # Per-section {origin, versionNumber} of the last change, or None if unknown.
    field_origins: dict[str, dict] | None = None
    # Set only by an edit: "created", "replayed" (this exact edit already
    # produced the current version) or "unchanged" (nothing differed).
    edit_result: str | None = None


class StudyNoteArtifactService:
    """Workspace-scoped retained-version reads, edits, sources, and export."""

    def __init__(self, session: Session, workspace_id: int) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        self._session = session
        self._repo = WorkspaceRepository(session, workspace_id)
        self._versions = ArtifactVersionService(session, workspace_id)

    def get_version(
        self, artifact_id: int, version_id: int | None = None
    ) -> StudyNoteVersion:
        """Return a retained owned Study Note version, defaulting to current."""
        try:
            artifact = self._study_note(artifact_id)
            selected_id = artifact.current_version_id if version_id is None else version_id
            if selected_id is None:
                raise StudyNoteArtifactNotFoundError("study note not found")
            version = self._repo.get_artifact_version(selected_id)
            if version is None or version.artifact_id != artifact.id:
                raise StudyNoteArtifactNotFoundError("study note not found")
            return self._version(artifact, version)
        except CrossWorkspaceError as exc:
            raise StudyNoteArtifactNotFoundError("study note not found") from exc
        except SQLAlchemyError as exc:
            raise StudyNoteArtifactUnavailableError("study note service unavailable") from exc

    def list_notes(self) -> list[dict]:
        """Owned study notes, newest first (Task 2.10 integration).

        Summaries only: id, current version number/origin, topic, ordered source
        IDs. Unreadable notes are skipped rather than failing the whole list.
        """
        try:
            notes = []
            for artifact in sorted(
                self._repo.list_artifacts(kind=_KIND_STUDY_NOTE),
                key=lambda a: a.id,
                reverse=True,
            ):
                try:
                    v = self.get_version(artifact.id)
                except (StudyNoteArtifactNotFoundError, StudyNoteArtifactUnavailableError):
                    continue
                notes.append({
                    "artifactId": v.artifact_id,
                    "versionNumber": v.version_number,
                    "origin": v.origin,
                    "topic": v.content.topic,
                    "sourceScreenshotIds": v.source_screenshot_ids,
                })
            return notes
        except SQLAlchemyError as exc:
            raise StudyNoteArtifactUnavailableError("study note service unavailable") from exc

    def list_versions(self, artifact_id: int) -> list[dict]:
        """All retained versions of an owned study note, oldest first."""
        try:
            artifact = self._study_note(artifact_id)
            versions = sorted(
                self._repo.list_artifact_versions(artifact.id),
                key=lambda v: v.version_number,
            )
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
            raise StudyNoteArtifactNotFoundError("study note not found") from exc
        except SQLAlchemyError as exc:
            raise StudyNoteArtifactUnavailableError("study note service unavailable") from exc

    def save_edit(
        self, artifact_id: int, raw_content: object, base_version_id: int | None = None
    ) -> StudyNoteVersion:
        """Insert a retained manual version and repoint current atomically.

        The callback neither updates nor deletes a historical version.  If
        validation, flushing, or commit fails, rollback leaves the original
        current pointer and every prior version unchanged.

        ``base_version_id`` (Batch 5A, always sent by the HTTP route) is the
        version the user edited. Under the workspace lock a stale base raises
        ``DraftVersionConflictError`` unless this exact edit already produced
        the current version (a replay, returned without a new insert); an edit
        identical to the current version inserts nothing. Without a base the
        service keeps its original behaviour (the design's concurrent
        Redo + Manual Edit guarantee at the service layer). Edits are refused
        while any source screenshot is archived.
        """
        try:
            try:
                editable = ManualStudyNoteContent.model_validate(raw_content)
            except (ValidationError, TypeError, ValueError) as exc:
                raise StudyNoteEditValidationError("Invalid study note content") from exc

            # Serialize number assignment and pointer movement.  This is a
            # narrow single-instance/DB transaction aid, not Task 3.1's full
            # concurrent redo conflict/retry implementation.
            if self._repo.lock_workspace() is None:
                raise StudyNoteArtifactNotFoundError("study note not found")
            artifact = self._study_note(artifact_id)
            current_row = (
                self._repo.get_artifact_version(artifact.current_version_id)
                if artifact.current_version_id is not None
                else None
            )
            # The stored note must agree with its authoritative source rows
            # before anything is appended (never repaired or replaced here).
            source_ids = (
                self._consistent_sources(artifact.id, self._parse_content(current_row.content_json))
                if current_row is not None
                else self._source_ids(artifact.id)
            )
            require_sources_active(self._repo, source_ids)
            content = StudyNoteResult(
                **editable.model_dump(), references=list(source_ids)
            )
            if base_version_id is not None:
                outcome = self._check_base(artifact, base_version_id, content)
                if outcome is not None:
                    self._session.rollback()  # release the lock; nothing changed
                    return outcome
            version = self._versions.append_version(
                artifact.id,
                json.dumps(content.model_dump(), ensure_ascii=False),
                _ORIGIN_MANUAL_EDIT,
            )
            saved = self._version(artifact, version)  # built BEFORE commit: nothing can fail after it
            outcome = StudyNoteVersion(**{**saved.__dict__, "edit_result": "created"})
            self._session.commit()
            return outcome
        except (StudyNoteArtifactError, DraftVersionConflictError, DraftSourceArchivedError):
            self._session.rollback()
            raise
        except DraftSourceMissingError as exc:
            self._session.rollback()
            raise StudyNoteArtifactUnavailableError("study note service unavailable") from exc
        except CrossWorkspaceError as exc:
            self._session.rollback()
            raise StudyNoteArtifactNotFoundError("study note not found") from exc
        except VersionConflictError as exc:
            # Contention outlasted the bounded retry: nothing was saved. Report
            # the same safe "try again" failure as any transient service error.
            self._session.rollback()
            raise StudyNoteArtifactUnavailableError("study note service unavailable") from exc
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise StudyNoteArtifactUnavailableError("study note service unavailable") from exc
        except Exception as exc:
            # Anything unexpected happens before commit, so "not saved" is the truth.
            self._session.rollback()
            raise StudyNoteArtifactUnavailableError("study note service unavailable") from exc

    @staticmethod
    def to_markdown(version: StudyNoteVersion) -> str:
        """Render one selected retained payload as portable CommonMark.

        Text is never normalized.  In particular, code strings are inserted
        verbatim between a fence longer than any backtick run they contain, so
        CRLF, indentation, Unicode and embedded fences remain valid Markdown.
        """
        content = version.content
        lines = [f"# {content.topic}", "", "## Main concepts", ""]
        lines.extend(f"- {item}" for item in content.main_concepts)
        lines.extend(["", "## Extracted code", ""])
        for code in content.extracted_code:
            fence = "`" * (max((len(run) for run in re.findall(r"`+", code)), default=2) + 1)
            lines.extend([fence, code, fence, ""])
        lines.extend(["## Code explanations", ""])
        lines.extend(f"- {item}" for item in content.code_explanations)
        lines.extend(["", "## Important pitfalls", ""])
        lines.extend(f"- {item}" for item in content.pitfalls)
        lines.extend(["", "## Uncertain/ambiguous content", ""])
        lines.extend(f"- {item}" for item in content.uncertain_content)
        lines.extend(["", "## References", ""])
        lines.extend(f"- Screenshot {sid}" for sid in version.source_screenshot_ids)
        return "\n".join(lines).rstrip() + "\n"

    def _check_base(self, artifact, base_version_id: int, content: StudyNoteResult) -> StudyNoteVersion | None:
        """None = proceed with the insert; otherwise the no-insert outcome."""
        if type(base_version_id) is not int or base_version_id <= 0:
            raise StudyNoteArtifactNotFoundError("study note not found")
        base = self._repo.get_artifact_version(base_version_id)
        current = (
            self._repo.get_artifact_version(artifact.current_version_id)
            if artifact.current_version_id is not None
            else None
        )
        if base is None or base.artifact_id != artifact.id or current is None:
            raise StudyNoteArtifactNotFoundError("study note not found")
        same_as_current = self._parse_content(current.content_json).model_dump() == content.model_dump()
        if base.id != current.id:
            # Replay needs lineage, not just equal content: the save that made
            # ``current`` was based on the version right before it.
            if (
                same_as_current
                and current.origin == _ORIGIN_MANUAL_EDIT
                and current.version_number == base.version_number + 1
            ):
                return StudyNoteVersion(**{**self._version(artifact, current).__dict__, "edit_result": "replayed"})
            raise DraftVersionConflictError(current.id, current.version_number)
        if same_as_current:
            return StudyNoteVersion(**{**self._version(artifact, current).__dict__, "edit_result": "unchanged"})
        return None

    def _version(self, artifact, version) -> StudyNoteVersion:
        content = self._parse_content(version.content_json)
        sources = self._consistent_sources(artifact.id, content)
        return StudyNoteVersion(
            artifact_id=artifact.id,
            version_id=version.id,
            version_number=version.version_number,
            origin=version.origin,
            content=content,
            source_screenshot_ids=sources,
            field_origins=field_origins(
                self._repo.list_artifact_versions(artifact.id),
                version.version_number,
                NOTE_FIELDS,
                lambda raw: self._history_content(raw, sources),
            ),
        )

    def _consistent_sources(self, artifact_id: int, content: StudyNoteResult) -> list[int]:
        """The authoritative sources, cross-checked against the stored payload.

        A note may have several sources (selection order). The workspace-scoped
        ``source_reference`` rows are the authority: they must be distinct,
        every screenshot must belong to this workspace, and the payload's
        ``references`` must equal them exactly (same ids, same order). Anything
        else is inconsistent stored data: the generic unavailable error, with no
        id or content echoed, and nothing repaired.
        """
        sources = self._source_ids(artifact_id)
        if len(set(sources)) != len(sources) or content.references != sources:
            raise StudyNoteArtifactUnavailableError("study note service unavailable")
        if any(self._repo.get_screenshot(sid) is None for sid in sources):
            raise StudyNoteArtifactUnavailableError("study note service unavailable")
        return sources

    def _history_content(self, raw: str, sources: list[int]) -> dict:
        """A historical payload for provenance: fully validated, same sources. Raises otherwise."""
        content = self._parse_content(raw)
        if content.references != sources:
            raise StudyNoteArtifactUnavailableError("study note service unavailable")
        return content.model_dump()

    def _study_note(self, artifact_id: int):
        artifact = self._repo.get_artifact(artifact_id)
        if artifact is None or artifact.kind != _KIND_STUDY_NOTE:
            raise StudyNoteArtifactNotFoundError("study note not found")
        return artifact

    def _source_ids(self, artifact_id: int) -> list[int]:
        # SourceReference insertion follows manual selection order.  The
        # repository deliberately has no implicit display order, so retain that
        # order here for provenance and Markdown attribution.
        return [ref.screenshot_id for ref in self._repo.list_source_references(artifact_id)]

    @staticmethod
    def _parse_content(content_json: str) -> StudyNoteResult:
        try:
            return StudyNoteResult.model_validate(json.loads(content_json))
        except (json.JSONDecodeError, ValidationError, TypeError, ValueError) as exc:
            raise StudyNoteArtifactUnavailableError("study note service unavailable") from exc
