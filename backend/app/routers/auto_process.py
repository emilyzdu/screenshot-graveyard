"""Auto-processing routes (Batch 6B).

  * GET  /api/workspace/automation          -> {"autoPrepare": bool}
  * POST /api/workspace/automation          body {"autoPrepare": bool}
        The workspace's opt-in preference. It is NOT consent: every screenshot
        still needs its own grant before anything is sent to an AI provider.
  * GET  /api/screenshots/{id}/auto-process -> the derived pipeline state
        (safe GET: reads only; a reload never starts or repeats anything).
  * POST /api/screenshots/{id}/auto-process
        An explicit "continue automatically" for one screenshot: analysis (if
        none exists yet) -> routing -> the routed draft preparation. 202 when
        work was scheduled, 200 when nothing new was needed (already running,
        already prepared, or nothing to prepare). Idempotent: repeated requests
        reuse the running analysis/preparation. 403 without consent, 409 when
        automation is off or the screenshot is archived.

CSRF middleware guards both POSTs. Identity is the trusted server-resolved
workspace only; a foreign or missing screenshot is a generic 404. Responses
never contain image bytes. Nothing is approved and nothing is delivered.
"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, StrictBool

from app.db.session import get_session
from app.routers.classification import _run_classification_job
from app.routers.preparations import _run_event_draft_job, _run_make_notes_job
from app.services.action_router import ACTION_ADD_CALENDAR
from app.services.auto_process_service import (
    RUNNING,
    AutoProcessArchivedError,
    AutoProcessDisabledError,
    AutoProcessNotFoundError,
    AutoProcessService,
    AutoProcessUnavailableError,
    AutoState,
    StepState,
)
from app.services.consent_service import (
    ConsentRequiredError,
    ConsentServiceUnavailableError,
    ScreenshotNotFoundError as ConsentScreenshotNotFoundError,
)
from app.services.operation_service import OperationQuotaExceededError, OperationServiceUnavailableError


class AutomationBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    autoPrepare: StrictBool


def _error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


def _err(code: int, key: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=code, content=_error_body(key, message))


def _resolved_workspace_or_response(request: Request):
    if getattr(request.state, "identity_unavailable", False):
        return None, _err(503, "identity_unavailable", "Service temporarily unavailable")
    workspace_id = getattr(request.state, "workspace_id", None)
    if workspace_id is None:
        return None, _err(401, "no_workspace", "No workspace")
    return workspace_id, None


def _step_dict(s: StepState | None) -> dict | None:
    if s is None:
        return None
    out = {"operationId": s.operation_id, "status": s.status, "artifactId": s.artifact_id,
           "errorDetail": s.error_detail, "provider": s.provider,
           # Who started it, from the operation's durable key: "auto" | "manual".
           "trigger": s.trigger}
    if s.action is not None:
        out["action"] = s.action
    return out


def _state_dict(st: AutoState) -> dict:
    return {
        "screenshotId": st.screenshot_id,
        "autoPrepare": st.enabled,
        "consent": st.consent,
        "stage": st.stage,
        "route": None if st.route is None else {
            "decision": st.route.decision, "action": st.route.action,
            "reasonCode": st.route.reason_code, "reason": st.route.reason,
        },
        "analysis": _step_dict(st.analysis),
        "preparation": _step_dict(st.preparation),
        "running": st.running,
    }


def _run_auto_pipeline(workspace_id: int, screenshot_id: int, classify_operation_id: int | None) -> None:
    """BackgroundTask: [analysis] -> routing -> [preparation]. Never raises out.

    Each step is the existing worker with its own consent re-check and dispatch
    authorization. Nothing is retried: a failed step ends the pipeline.
    """
    try:
        if classify_operation_id is not None:
            _run_classification_job(workspace_id, screenshot_id, classify_operation_id)
        prep = None
        session = get_session()
        try:
            prep = AutoProcessService(session, workspace_id).auto_preparation(screenshot_id)
        except Exception:
            # Consent revoked, archived, quota, database: the automatic step is
            # simply not taken. The derived state shows what is left to do.
            session.rollback()
            prep = None
        finally:
            session.close()
        if prep is not None and not prep.reused:
            job = _run_event_draft_job if prep.action == ACTION_ADD_CALENDAR else _run_make_notes_job
            job(workspace_id, screenshot_id, prep.operation.operation_id)
    except Exception:
        pass  # each worker already records its own terminal status
    finally:
        RUNNING.release(workspace_id, screenshot_id)


def build_auto_process_router() -> APIRouter:
    router = APIRouter(prefix="/api", tags=["auto-process"])

    @router.get("/workspace/automation", response_model=None)
    def get_automation(request: Request):
        workspace_id, err = _resolved_workspace_or_response(request)
        if err is not None:
            return err
        session = get_session()
        try:
            return {"autoPrepare": AutoProcessService(session, workspace_id).preference()}
        except AutoProcessUnavailableError:
            return _err(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()

    @router.post("/workspace/automation", response_model=None)
    def set_automation(request: Request, body: AutomationBody):
        workspace_id, err = _resolved_workspace_or_response(request)
        if err is not None:
            return err
        session = get_session()
        try:
            return {"autoPrepare": AutoProcessService(session, workspace_id).set_preference(body.autoPrepare)}
        except AutoProcessUnavailableError:
            return _err(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()

    @router.get("/screenshots/{screenshot_id}/auto-process", response_model=None)
    def get_auto_process(request: Request, screenshot_id: int):
        workspace_id, err = _resolved_workspace_or_response(request)
        if err is not None:
            return err
        session = get_session()
        try:
            return _state_dict(AutoProcessService(session, workspace_id).state(screenshot_id))
        except AutoProcessNotFoundError:
            return _err(404, "not_found", "Not Found")
        except AutoProcessUnavailableError:
            return _err(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()

    @router.post("/screenshots/{screenshot_id}/auto-process", response_model=None)
    def start_auto_process(request: Request, screenshot_id: int, background: BackgroundTasks):
        workspace_id, err = _resolved_workspace_or_response(request)
        if err is not None:
            return err
        # One pipeline per screenshot at a time (in-process). A second request
        # while one runs only reads the state.
        claimed = RUNNING.claim(workspace_id, screenshot_id)
        schedule: tuple[int | None] | None = None
        session = get_session()
        try:
            service = AutoProcessService(session, workspace_id)
            try:
                if not claimed:
                    return _state_dict(service.state(screenshot_id))
                state, new_op, run = service.start(screenshot_id)
            except (AutoProcessNotFoundError, ConsentScreenshotNotFoundError):
                return _err(404, "not_found", "Not Found")
            except AutoProcessArchivedError:
                return _err(409, "screenshot_archived", "Resurrect this screenshot before processing it")
            except AutoProcessDisabledError:
                return _err(409, "automation_off", "Automatic processing is turned off")
            except ConsentRequiredError:
                return _err(403, "consent_required", "AI processing consent required")
            except OperationQuotaExceededError:
                return _err(429, "quota_exceeded", "AI operation quota exceeded")
            except (AutoProcessUnavailableError, OperationServiceUnavailableError, ConsentServiceUnavailableError):
                return _err(503, "service_unavailable", "Service temporarily unavailable")
            if run:
                schedule = (new_op.operation_id if new_op is not None else None,)
            return JSONResponse(
                status_code=status.HTTP_202_ACCEPTED if run else status.HTTP_200_OK,
                content=_state_dict(state),
            )
        finally:
            session.close()
            if claimed:
                if schedule is None:
                    RUNNING.release(workspace_id, screenshot_id)
                else:
                    # Released by the pipeline when it ends.
                    background.add_task(_run_auto_pipeline, workspace_id, screenshot_id, schedule[0])

    return router
