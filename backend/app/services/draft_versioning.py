"""Shared helpers for version-aware manual edits of drafts (Batch 5A).

Two small contracts used by both the Study Note and the Event Draft edit paths:

* **Field provenance** is DERIVED from the immutable version history, never
  stored or guessed: a field's origin is the origin of the latest version (at or
  before the one being read) in which its value changed. Version 1 sets every
  field. A field the user never changed therefore keeps its AI origin, even if
  other fields of the same draft were edited. If any earlier version cannot be
  parsed, provenance is reported as unknown (``None``) instead of guessed.

* **Optimistic concurrency** for user edits: a save names the version it was
  based on. Under the workspace write lock, a stale base is a conflict, except
  for an exact replay of the request that already produced the current version
  (a lost-response retry), which returns that version without a new insert.
"""

from __future__ import annotations

from typing import Callable, Iterable

from app.db import models
from app.db.repository import WorkspaceRepository


class DraftVersionConflictError(Exception):
    """The edit was based on a version that is no longer current."""

    def __init__(self, current_version_id: int, current_version_number: int) -> None:
        super().__init__("draft changed since this edit started")
        self.current_version_id = current_version_id
        self.current_version_number = current_version_number


class DraftSourceArchivedError(Exception):
    """A source screenshot is in The Crypt; its drafts are read-only."""


class DraftSourceMissingError(Exception):
    """A source reference points at no screenshot of this workspace (inconsistent data)."""


# The only origins provenance may report. Anything else is not guessed at.
KNOWN_ORIGINS = frozenset({"ai_generate", "ai_redo", "manual_edit"})


def field_origins(
    versions: Iterable[models.ArtifactVersion],
    upto_version_number: int,
    fields: tuple[str, ...],
    parse: Callable[[str], dict],
) -> dict[str, dict] | None:
    """Per-field ``{origin, versionNumber}`` of the last change at or before a version.

    Returns ``None`` (unknown) instead of guessing when the history is not a
    complete, readable chain 1..N: a gap, an unrecognised origin, or any version
    that ``parse`` rejects (``parse`` must fully validate the payload, including
    its source references, and raise on anything inconsistent). Nothing is
    repaired or rewritten.
    """
    out: dict[str, dict] = {}
    previous: dict | None = None
    expected = 1
    try:
        for version in sorted(versions, key=lambda v: v.version_number):
            if version.version_number > upto_version_number:
                break
            if version.version_number != expected or version.origin not in KNOWN_ORIGINS:
                return None
            expected += 1
            content = parse(version.content_json)
            if not isinstance(content, dict):
                return None
            for field in fields:
                if previous is None or content.get(field) != previous.get(field):
                    out[field] = {"origin": version.origin, "versionNumber": version.version_number}
            previous = content
    except Exception:
        return None  # history unreadable: say so rather than guess
    if previous is None or expected - 1 != upto_version_number:
        return None
    return out


def require_sources_active(repo: WorkspaceRepository, source_ids: list[int]) -> None:
    """Refuse edits while any source screenshot is archived.

    Only an archived source blocks an edit. Event drafts additionally require
    exactly one consistent source when they are read (Batch 4B).
    """
    for sid in source_ids:
        shot = repo.get_screenshot(sid)
        if shot is None:
            raise DraftSourceMissingError("source screenshot not found")
        if shot.state != "active":
            raise DraftSourceArchivedError("source screenshot is archived")
