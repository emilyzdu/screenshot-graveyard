"""Calendar event draft routes: reads (Batch 4B) and manual edits (Batch 5A).

  * GET  /api/event-drafts/{artifactId}[?versionId=]   a retained version (current by default)
  * GET  /api/event-drafts/{artifactId}/versions       all retained versions, oldest first
  * POST /api/event-drafts/{artifactId}/edits          append ONE manual version (CSRF-guarded)
        body {"baseVersionId", "content": {editable fields}, "uncertainFields": [...]}
        200 {..., "editResult": created | replayed | unchanged}
        400 invalid_content (+ safe "field"), 404, 409 version_conflict / screenshot_archived, 503

Identity is the trusted server-resolved workspace only (401/503 fail closed).
Missing, foreign and non-event artifacts are the same generic 404. There is no
approve, delete or delivery route, and nothing here calls an AI adapter or
writes to any external application.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from app.db.session import get_session
from app.routers.study_note_artifacts import archived_response, conflict_response
from app.services.draft_versioning import DraftSourceArchivedError, DraftVersionConflictError
from app.services.event_draft_artifact_service import (
    EventDraftArtifactService,
    EventDraftEditValidationError,
    EventDraftNotFoundError,
    EventDraftUnavailableError,
    EventDraftVersion,
)


class EventDraftEditBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    baseVersionId: StrictInt = Field(gt=0)
    # Shape is validated by the service (EventDraftEditContent) so errors are safe 400s.
    content: dict
    uncertainFields: list[str] = Field(default_factory=list)


def _version_dict(v: EventDraftVersion) -> dict:
    return {
        "artifactId": v.artifact_id,
        "versionId": v.version_id,
        "versionNumber": v.version_number,
        "origin": v.origin,
        "content": v.content.model_dump(mode="json"),
        "sourceScreenshotIds": v.source_screenshot_ids,
        "fieldOrigins": v.field_origins,
    }


def _error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


def _workspace(request: Request):
    if getattr(request.state, "identity_unavailable", False):
        return None, JSONResponse(
            status_code=503, content=_error_body("identity_unavailable", "Service temporarily unavailable")
        )
    workspace_id = getattr(request.state, "workspace_id", None)
    if workspace_id is None:
        return None, JSONResponse(status_code=401, content=_error_body("no_workspace", "No workspace"))
    return workspace_id, None


def build_event_drafts_router() -> APIRouter:
    router = APIRouter(prefix="/api/event-drafts", tags=["event-drafts"])

    @router.get("/{artifact_id}/versions", response_model=None)
    def list_event_draft_versions(request: Request, artifact_id: int):
        workspace_id, err = _workspace(request)
        if err is not None:
            return err
        session = get_session()
        try:
            return {"versions": EventDraftArtifactService(session, workspace_id).list_versions(artifact_id)}
        except EventDraftNotFoundError:
            return JSONResponse(status_code=404, content=_error_body("not_found", "Not Found"))
        except EventDraftUnavailableError:
            return JSONResponse(status_code=503, content=_error_body("service_unavailable", "Service temporarily unavailable"))
        finally:
            session.close()

    @router.get("/{artifact_id}", response_model=None)
    def get_event_draft(request: Request, artifact_id: int, versionId: int | None = None):
        workspace_id, err = _workspace(request)
        if err is not None:
            return err
        session = get_session()
        try:
            v = EventDraftArtifactService(session, workspace_id).get_version(artifact_id, versionId)
        except EventDraftNotFoundError:
            return JSONResponse(status_code=404, content=_error_body("not_found", "Not Found"))
        except EventDraftUnavailableError:
            return JSONResponse(status_code=503, content=_error_body("service_unavailable", "Service temporarily unavailable"))
        finally:
            session.close()
        return _version_dict(v)

    @router.post("/{artifact_id}/edits", response_model=None)
    def save_event_draft_edit(request: Request, artifact_id: int, body: EventDraftEditBody):
        """CSRF middleware protects this state-changing, append-only save."""
        workspace_id, err = _workspace(request)
        if err is not None:
            return err
        session = get_session()
        try:
            outcome = EventDraftArtifactService(session, workspace_id).save_edit(
                artifact_id, body.baseVersionId, body.content, body.uncertainFields
            )
            return {**_version_dict(outcome.version), "editResult": outcome.result}
        except EventDraftEditValidationError as exc:
            error = {"code": "invalid_content", "message": exc.message}
            if exc.field:
                error["field"] = exc.field
            return JSONResponse(status_code=400, content={"error": error})
        except DraftVersionConflictError as exc:
            return conflict_response(exc)
        except DraftSourceArchivedError:
            return archived_response()
        except EventDraftNotFoundError:
            return JSONResponse(status_code=404, content=_error_body("not_found", "Not Found"))
        except EventDraftUnavailableError:
            return JSONResponse(status_code=503, content=_error_body("service_unavailable", "Service temporarily unavailable"))
        finally:
            session.close()

    return router
