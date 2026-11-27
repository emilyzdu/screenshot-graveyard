"""Draft preparation routes: Make Notes (Batch 4A) and Add to Calendar (Batch 4B).

  * POST /api/screenshots/{id}/preparations
        body {"action": "make_notes"} or {"action": "add_calendar"}
        202 + operationId when a new preparation was started,
        200 + the existing operation when one is still running or already
        produced a draft (idempotent: repeated clicks and concurrent requests
        never create a second draft). CSRF middleware guards this POST.
  * GET  /api/screenshots/{id}/preparations/{action}
        The newest preparation for that screenshot (404 if none), so a
        reloaded page can reopen its draft. Safe GET.

Identity is the trusted server-resolved workspace only (401/503 fail closed);
a foreign or missing screenshot is the same generic 404. Poll a started
operation with the existing GET /api/operations/{id}; read a notes draft with
GET /api/study-notes/{artifactId} and an event draft with
GET /api/event-drafts/{artifactId}. Responses never contain image bytes.
Nothing is written to any external calendar or application.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from app import config
from app.ai.provider import get_ai_adapter
from app.db.repository import WorkspaceRepository
from app.db.session import get_session
from app.services.consent_service import (
    ConsentRequiredError,
    ConsentServiceUnavailableError,
    ScreenshotNotFoundError as ConsentScreenshotNotFoundError,
)
from app.services.operation_service import (
    OperationQuotaExceededError,
    OperationService,
    OperationServiceUnavailableError,
)
from app.services.event_draft_service import EventDraftService
from app.services.preparation_service import (
    ACTION_ADD_CALENDAR,
    PERMITTED_PROVIDERS,
    provider_from_key,
    Preparation,
    PreparationNotActiveError,
    PreparationNotFoundError,
    PreparationProviderBlockedError,
    PreparationService,
    PreparationUnavailableError,
    PreparationUnsupportedActionError,
)
from app.services.study_note_service import StudyNoteService


class PreparationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Any other value is a 422: only these two actions can be prepared.
    action: Literal["make_notes", "add_calendar"]


def _error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


def _resolved_workspace_or_response(request: Request):
    if getattr(request.state, "identity_unavailable", False):
        return None, JSONResponse(
            status_code=503,
            content=_error_body("identity_unavailable", "Service temporarily unavailable"),
        )
    workspace_id = getattr(request.state, "workspace_id", None)
    if workspace_id is None:
        return None, JSONResponse(status_code=401, content=_error_body("no_workspace", "No workspace"))
    return workspace_id, None


def _preparation_dict(p: Preparation) -> dict:
    op = p.operation
    return {
        "screenshotId": p.screenshot_id,
        "action": p.action,
        "operationId": op.operation_id,
        "kind": op.kind,
        "status": op.status,
        "artifactId": op.artifact_id,
        "errorDetail": op.error_detail,
        # The provider recorded with this preparation (from its durable key).
        "provider": p.provider,
        "reused": p.reused,
        # Batch 6B: who started it ("auto" | "manual"), from its durable key.
        "trigger": p.trigger,
    }


def _fail(workspace_id: int, operation_id: int, detail: str) -> None:
    session = get_session()
    try:
        OperationService(session, workspace_id).set_terminal_status(operation_id, "failed", error_detail=detail)
    finally:
        session.close()


def _run_make_notes_job(workspace_id: int, screenshot_id: int, operation_id: int) -> None:
    """BackgroundTask body. Re-checks the guards, then the unchanged Study Note worker."""
    _run_guarded(
        workspace_id,
        screenshot_id,
        operation_id,
        lambda session: StudyNoteService(session, workspace_id, adapter=get_ai_adapter()).run_generation(
            [screenshot_id], operation_id
        ),
    )


def _run_event_draft_job(workspace_id: int, screenshot_id: int, operation_id: int) -> None:
    """BackgroundTask body. Re-checks the guards, then the Event Draft worker."""
    _run_guarded(
        workspace_id,
        screenshot_id,
        operation_id,
        lambda session: EventDraftService(session, workspace_id, adapter=get_ai_adapter()).run_generation(
            screenshot_id, operation_id
        ),
    )


def _run_guarded(workspace_id: int, screenshot_id: int, operation_id: int, generate) -> None:
    """Provider, existence and active-state guards shared by every preparation job.

    The worker itself re-checks ownership and consent before any bytes are read,
    makes exactly one adapter call and persists the draft atomically.
    """
    try:
        session = get_session()
        try:
            repo = WorkspaceRepository(session, workspace_id)
            # Fail closed if the provider changed after acceptance: a request
            # accepted (and shown) as simulated is never sent to a real provider,
            # and a real-provider request never silently becomes simulated.
            op = repo.get_operation(operation_id)
            recorded = provider_from_key(op.idempotency_key) if op is not None else None
            if config.AI_PROVIDER not in PERMITTED_PROVIDERS or recorded != config.AI_PROVIDER:
                session.close()
                _fail(workspace_id, operation_id, "AI processing unavailable")
                return
            shot = repo.get_screenshot(screenshot_id)
            if shot is None:
                session.close()
                _fail(workspace_id, operation_id, "Not found")
                return
            if shot.state != "active":
                session.close()
                _fail(workspace_id, operation_id, "Screenshot archived")
                return
            generate(session)
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()
    except Exception:
        # Never strand a pollable operation in pending; never report success.
        try:
            _fail(workspace_id, operation_id, "AI analysis failed")
        except Exception:
            pass


def build_preparations_router() -> APIRouter:
    router = APIRouter(prefix="/api/screenshots", tags=["preparations"])

    @router.post("/{screenshot_id}/preparations", response_model=None)
    def request_preparation(
        request: Request, screenshot_id: int, body: PreparationBody, background: BackgroundTasks
    ):
        workspace_id, err = _resolved_workspace_or_response(request)
        if err is not None:
            return err
        session = get_session()
        try:
            try:
                prep = PreparationService(session, workspace_id).request(screenshot_id, body.action)
            except PreparationUnsupportedActionError:
                return JSONResponse(status_code=400, content=_error_body(
                    "unsupported_action", "This action cannot be prepared in this version"))
            except PreparationProviderBlockedError:
                return JSONResponse(status_code=409, content=_error_body(
                    "provider_not_permitted",
                    "Preparation is not available with the configured AI provider"))
            except (PreparationNotFoundError, ConsentScreenshotNotFoundError):
                return JSONResponse(status_code=404, content=_error_body("not_found", "Not Found"))
            except PreparationNotActiveError:
                return JSONResponse(status_code=409, content=_error_body(
                    "screenshot_archived", "Resurrect this screenshot before preparing a draft"))
            except ConsentRequiredError:
                return JSONResponse(status_code=403, content=_error_body(
                    "consent_required", "AI processing consent required"))
            except OperationQuotaExceededError:
                return JSONResponse(status_code=429, content=_error_body(
                    "quota_exceeded", "AI operation quota exceeded"))
            except (PreparationUnavailableError, OperationServiceUnavailableError, ConsentServiceUnavailableError):
                return JSONResponse(status_code=503, content=_error_body(
                    "service_unavailable", "Service temporarily unavailable"))
        finally:
            session.close()
        if prep.reused:
            # Existing preparation stands: nothing new is scheduled or processed.
            return JSONResponse(status_code=status.HTTP_200_OK, content=_preparation_dict(prep))
        job = _run_event_draft_job if body.action == ACTION_ADD_CALENDAR else _run_make_notes_job
        background.add_task(job, workspace_id, screenshot_id, prep.operation.operation_id)
        return JSONResponse(status_code=status.HTTP_202_ACCEPTED, content=_preparation_dict(prep))

    @router.get("/{screenshot_id}/preparations/{action}", response_model=None)
    def latest_preparation(request: Request, screenshot_id: int, action: str):
        workspace_id, err = _resolved_workspace_or_response(request)
        if err is not None:
            return err
        session = get_session()
        try:
            try:
                prep = PreparationService(session, workspace_id).latest(screenshot_id, action)
            except PreparationUnsupportedActionError:
                return JSONResponse(status_code=400, content=_error_body(
                    "unsupported_action", "This action cannot be prepared in this version"))
            except PreparationNotFoundError:
                return JSONResponse(status_code=404, content=_error_body("not_found", "Not Found"))
            except PreparationUnavailableError:
                return JSONResponse(status_code=503, content=_error_body(
                    "service_unavailable", "Service temporarily unavailable"))
        finally:
            session.close()
        if prep is None:
            return JSONResponse(status_code=404, content=_error_body("no_preparation", "No preparation yet"))
        return _preparation_dict(prep)

    return router
