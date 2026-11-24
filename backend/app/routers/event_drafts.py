"""Read-only calendar event draft routes (Batch 4B).

  * GET /api/event-drafts/{artifactId}[?versionId=]   a retained version (current by default)
  * GET /api/event-drafts/{artifactId}/versions       all retained versions, oldest first

Identity is the trusted server-resolved workspace only (401/503 fail closed).
Missing, foreign and non-event artifacts are the same generic 404. There is no
edit, approve, delete or delivery route: nothing here writes anywhere.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.db.session import get_session
from app.services.event_draft_artifact_service import (
    EventDraftArtifactService,
    EventDraftNotFoundError,
    EventDraftUnavailableError,
)


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
        return {
            "artifactId": v.artifact_id,
            "versionId": v.version_id,
            "versionNumber": v.version_number,
            "origin": v.origin,
            "content": v.content.model_dump(mode="json"),
            "sourceScreenshotIds": v.source_screenshot_ids,
        }

    return router
