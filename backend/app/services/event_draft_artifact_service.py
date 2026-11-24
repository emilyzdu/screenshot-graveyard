"""Read-only access to persisted calendar event drafts (Batch 4B).

Workspace-scoped reads of an ``event_draft`` artifact's retained versions and
its source screenshots. A missing, foreign or other-kind artifact is the same
not-found error (no existence disclosure). There is no edit, approve, delete or
delivery path here: those are later batches.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.ai.schemas import EventDraftResult
from app.db.repository import CrossWorkspaceError, WorkspaceRepository
from app.services.event_draft_service import KIND_EVENT_DRAFT


class EventDraftArtifactError(Exception):
    """Base error for event draft reads."""


class EventDraftNotFoundError(EventDraftArtifactError):
    """Missing, foreign or not an event draft (identical, non-disclosing)."""


class EventDraftUnavailableError(EventDraftArtifactError):
    """Database unavailable, or stored content no longer validates."""


@dataclass(frozen=True)
class EventDraftVersion:
    artifact_id: int
    version_id: int
    version_number: int
    origin: str
    content: EventDraftResult
    source_screenshot_ids: list[int]


class EventDraftArtifactService:
    def __init__(self, session: Session, workspace_id: int) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        self._repo = WorkspaceRepository(session, workspace_id)

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
            content = self._parse(version.content_json)
            sources = self._consistent_sources(artifact.id, content)
            return EventDraftVersion(
                artifact_id=artifact.id,
                version_id=version.id,
                version_number=version.version_number,
                origin=version.origin,
                content=content,
                source_screenshot_ids=sources,
            )
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
