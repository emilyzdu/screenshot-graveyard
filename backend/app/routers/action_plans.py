"""AI action plans and their human-authorized execution.

  * POST /api/screenshots/{id}/action-plan         start (or reuse) AI planning
        body {"replan": false}. 202 + operation, or 200 with the reused one.
  * GET  /api/screenshots/{id}/action-plan         newest planning operation (404 if none)
  * GET  /api/action-plans/{artifactId}[?versionId=] one plan version, its
        per-action problems, the exact tool arguments that would be sent, and
        its executions
  * GET  /api/action-plans/{artifactId}/versions
  * POST /api/action-plans/{artifactId}/revisions  {"baseVersionId", "actions": [...]}
        appends a manual version (and re-binds destinations server-side)
  * POST /api/action-plans/{artifactId}/executions
        {"versionId", "actionIndex", "contentSha256", "confirmExecute": true}
        202 + the reserved execution; the write is dispatched in the background
  * GET  /api/action-plans/{artifactId}/executions
  * GET  /api/tool-executions/{executionId}

Approve a plan version with the existing ``POST /api/artifacts/{id}/approvals``.
Approval is not execution: the executions route is the separate authorization.
"""
from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, field_validator

from app.ai.action_plan import ARGUMENT_BLOCK
from app.ai.provider import get_ai_adapter
from app.db.session import get_session
from app.routers.integrations import tools_status, workspace_or_error
from app.routers.study_note_artifacts import conflict_response
from app.services.action_plan_service import (
    ActionPlanEditValidationError,
    ActionPlanNotFoundError,
    ActionPlanNotRevisableError,
    ActionPlanService,
    ActionPlanToolsDisabledError,
    ActionPlanUnavailableError,
    ActionPlanVersion,
    plan_eligibility,
)
from app.services.approval_service import ApprovalNotFoundError, ApprovalService, ApprovalUnavailableError
from app.services.consent_service import ConsentRequiredError, ConsentServiceUnavailableError
from app.services.draft_versioning import DraftSourceArchivedError, DraftVersionConflictError
from app.services.operation_service import (
    OperationQuotaExceededError,
    OperationService,
    OperationServiceUnavailableError,
    OperationState,
)
from app.services.tool_execution_service import (
    ExecutionDuplicateError,
    ExecutionError,
    ExecutionView,
    ToolExecutionService,
)
from app.tools.arguments import ArgumentError, action_problems, build_arguments, delivery_key, scope_key
from app.tools.catalog import CATALOG, TOOLKIT_LABELS

_STATUS_BY_CODE = {
    "tools_disabled": 409, "live_writes_disabled": 409, "not_found": 404, "not_approved": 409,
    "version_conflict": 409, "action_not_ready": 409, "reconnect_required": 409,
    "screenshot_archived": 409, "already_executed": 409, "service_unavailable": 503,
    "execution_refused": 409,
}


def _error(status_code: int, code: str, message: str, **extra) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message, **extra}})


class PlanBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    replan: StrictBool = False


class RevisionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    baseVersionId: StrictInt = Field(gt=0)
    actions: list[dict] = Field(max_length=3)


class ExecutionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    versionId: StrictInt = Field(gt=0)
    actionIndex: StrictInt = Field(ge=0, lt=3)
    contentSha256: StrictStr = Field(min_length=64, max_length=64)
    confirmExecute: StrictBool

    @field_validator("confirmExecute")
    @classmethod
    def _must_be_true(cls, v: bool) -> bool:
        if v is not True:
            raise ValueError("confirmExecute must be true")
        return v


def _operation_dict(op: OperationState, reused: bool | None = None) -> dict:
    out = {"operationId": op.operation_id, "kind": op.kind, "status": op.status,
           "artifactId": op.artifact_id, "errorDetail": op.error_detail}
    if reused is not None:
        out["reused"] = reused
    return out


def execution_dict(e: ExecutionView) -> dict:
    return {
        "executionId": e.execution_id, "artifactId": e.artifact_id, "versionId": e.version_id,
        "actionIndex": e.action_index, "attempt": e.attempt, "tool": e.tool, "toolkit": e.toolkit,
        "toolkitVersion": e.toolkit_version, "status": e.status, "simulated": e.simulated,
        # A receipt exists only for a succeeded execution.
        "receipt": ({"externalId": e.external_id, "url": e.external_url, "verified": e.receipt_verified is True}
                    if e.status == "succeeded" else None),
        "detail": e.detail, "createdAt": e.created_at, "completedAt": e.completed_at,
    }


def _plan_dict(v: ActionPlanVersion, artifact_current_id: int | None, workspace_id: int,
               history: dict[str, list] | None = None) -> dict:
    c = v.content
    sid = v.source_screenshot_ids[0]
    reasons, required, ai_fields = plan_eligibility(v)
    actions = []
    for a in c.actions:
        block = ARGUMENT_BLOCK[a.tool]
        try:
            preview = build_arguments(a, delivery_key(workspace_id, sid, a))
        except ArgumentError:
            preview = None
        scope = scope_key(workspace_id, sid, a)
        actions.append({
            "index": a.index,
            "tool": a.tool,
            "toolkit": a.toolkit,
            "appLabel": TOOLKIT_LABELS[a.toolkit],
            "actionLabel": CATALOG[a.tool].label,
            "toolkitVersion": a.toolkit_version,
            "enabled": a.enabled,
            "rationale": a.rationale,
            "confidence": a.confidence,
            "argumentBlock": block,
            "arguments": getattr(a, block).model_dump(),
            "problems": action_problems(a),
            "destination": ({"connectionId": a.destination.connection_id, "simulated": a.destination.mode == "fake"}
                            if a.destination else None),
            # Exactly what would be sent if this version is approved and authorized.
            "toolArguments": preview,
            # Every execution of this tool for this screenshot and app, from ANY
            # plan (replans included), so an unresolved write is never hidden.
            "deliveryHistory": [execution_dict(e) for e in (history or {}).get(scope, [])],
        })
    return {
        "artifactId": v.artifact_id,
        "versionId": v.version_id,
        "versionNumber": v.version_number,
        "origin": v.origin,
        "isCurrent": v.version_id == artifact_current_id,
        "contentSha256": v.content_sha256,
        "screenshotId": v.source_screenshot_ids[0],
        "decision": c.decision,
        "rationale": c.rationale,
        "clarificationQuestion": c.clarification_question,
        "plannerProvider": c.planner_provider,
        "toolsMode": c.tools_mode,
        "simulated": c.tools_mode == "fake",
        "actions": actions,
        "fieldOrigins": v.field_origins,
        "approvalReadiness": {"eligible": not reasons, "reasons": reasons,
                              "requiredAcknowledgements": required, "aiOriginFields": ai_fields},
    }


def _run_planning_job(workspace_id: int, screenshot_id: int, operation_id: int) -> None:
    try:
        session = get_session()
        try:
            ActionPlanService(session, workspace_id, adapter=get_ai_adapter()).run_planning(screenshot_id, operation_id)
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()
    except Exception:
        session = get_session()
        try:
            OperationService(session, workspace_id).set_terminal_status(operation_id, "failed", error_detail="AI planning failed")
        except Exception:
            pass
        finally:
            session.close()


def _run_execution_job(workspace_id: int, reservation) -> None:
    session = get_session()
    try:
        ToolExecutionService(session, workspace_id).dispatch(reservation)
    except Exception:
        session.rollback()  # the row stays 'executing' -> reported unknown, never retried
    finally:
        session.close()


def build_action_plans_router() -> APIRouter:
    router = APIRouter(prefix="/api", tags=["action-plans"])

    @router.post("/screenshots/{screenshot_id}/action-plan", response_model=None)
    def request_plan(request: Request, screenshot_id: int, background: BackgroundTasks, body: PlanBody | None = None):
        workspace_id, err = workspace_or_error(request)
        if err is not None:
            return err
        session = get_session()
        try:
            state, reused = ActionPlanService(session, workspace_id).request_planning(
                screenshot_id, replan=bool(body and body.replan))
        except ActionPlanToolsDisabledError:
            return _error(409, "tools_disabled", "External apps are not enabled on this server")
        except ActionPlanNotFoundError:
            return _error(404, "not_found", "Not Found")
        except DraftSourceArchivedError:
            return _error(409, "screenshot_archived", "Resurrect this screenshot before planning")
        except ConsentRequiredError:
            return _error(403, "consent_required", "AI processing consent required")
        except OperationQuotaExceededError as exc:
            return _error(429, exc.code, exc.public_message)
        except (ActionPlanUnavailableError, OperationServiceUnavailableError, ConsentServiceUnavailableError):
            return _error(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()
        if reused:
            return JSONResponse(status_code=200, content=_operation_dict(state, True))
        background.add_task(_run_planning_job, workspace_id, screenshot_id, state.operation_id)
        return JSONResponse(status_code=202, content=_operation_dict(state, False))

    @router.get("/screenshots/{screenshot_id}/action-plan", response_model=None)
    def latest_plan(request: Request, screenshot_id: int):
        workspace_id, err = workspace_or_error(request)
        if err is not None:
            return err
        session = get_session()
        try:
            op = ActionPlanService(session, workspace_id).latest_for_screenshot(screenshot_id)
            if op is None:
                return _error(404, "not_found", "No plan yet")
            return _operation_dict(OperationService._state(op))
        except ActionPlanNotFoundError:
            return _error(404, "not_found", "Not Found")
        except ActionPlanUnavailableError:
            return _error(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()

    @router.get("/action-plans/{artifact_id}", response_model=None)
    def get_plan(request: Request, artifact_id: int, versionId: int | None = None):
        workspace_id, err = workspace_or_error(request)
        if err is not None:
            return err
        session = get_session()
        try:
            plans = ActionPlanService(session, workspace_id)
            view = plans.get_version(artifact_id, versionId)
            current = plans.get_version(artifact_id).version_id
            exec_service = ToolExecutionService(session, workspace_id)
            executions = exec_service.list_for_plan(artifact_id)
            sid = view.source_screenshot_ids[0]
            history = exec_service.history_for_scopes([scope_key(workspace_id, sid, a) for a in view.content.actions])
            # Approval state from the verified ledger (hash re-checked), never inferred.
            try:
                status = ApprovalService(session, workspace_id).status(artifact_id)
                record = next((a for a in status.approvals if a.version_id == view.version_id), None)
                approval = {"state": "approved" if record else "not_approved",
                            "approvedAt": record.approved_at if record else None}
            except (ApprovalNotFoundError, ApprovalUnavailableError):
                approval = {"state": "unknown", "approvedAt": None}
            return {**_plan_dict(view, current, workspace_id, history), "tools": tools_status(), "approval": approval,
                    "executions": [execution_dict(e) for e in executions]}
        except (ActionPlanNotFoundError,):
            return _error(404, "not_found", "Not Found")
        except ExecutionError as exc:
            return _error(_STATUS_BY_CODE.get(exc.code, 409), exc.code, exc.message)
        except ActionPlanUnavailableError:
            return _error(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()

    @router.get("/action-plans/{artifact_id}/versions", response_model=None)
    def plan_versions(request: Request, artifact_id: int):
        workspace_id, err = workspace_or_error(request)
        if err is not None:
            return err
        session = get_session()
        try:
            return {"artifactId": artifact_id, "versions": ActionPlanService(session, workspace_id).list_versions(artifact_id)}
        except ActionPlanNotFoundError:
            return _error(404, "not_found", "Not Found")
        except ActionPlanUnavailableError:
            return _error(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()

    @router.post("/action-plans/{artifact_id}/revisions", response_model=None)
    def revise_plan(request: Request, artifact_id: int, body: RevisionBody):
        workspace_id, err = workspace_or_error(request)
        if err is not None:
            return err
        session = get_session()
        try:
            plans = ActionPlanService(session, workspace_id)
            view, result = plans.save_revision(artifact_id, body.baseVersionId, body.actions)
            content = {**_plan_dict(view, view.version_id, workspace_id), "editResult": result}
            return JSONResponse(status_code=201 if result == "created" else 200, content=content)
        except ActionPlanNotFoundError:
            return _error(404, "not_found", "Not Found")
        except DraftVersionConflictError as exc:
            return conflict_response(exc)
        except DraftSourceArchivedError:
            return _error(409, "screenshot_archived", "Resurrect the screenshot before editing its plan")
        except ActionPlanNotRevisableError:
            return _error(409, "not_revisable", "This plan has no actions to edit")
        except ActionPlanEditValidationError as exc:
            extra = {"field": exc.field} if exc.field else {}
            return _error(400, "invalid_plan", exc.message, **extra)
        except ActionPlanUnavailableError:
            return _error(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()

    @router.post("/action-plans/{artifact_id}/executions", response_model=None)
    def execute_action(request: Request, artifact_id: int, body: ExecutionBody, background: BackgroundTasks):
        """The explicit authorization of ONE external write. CSRF-guarded."""
        workspace_id, err = workspace_or_error(request)
        if err is not None:
            return err
        session = get_session()
        try:
            service = ToolExecutionService(session, workspace_id)
            reservation = service.authorize(artifact_id, body.versionId, body.actionIndex, body.contentSha256)
            view = service.get(reservation.execution_id)
        except ExecutionDuplicateError as exc:
            return _error(409, exc.code, exc.message,
                          execution=execution_dict(exc.existing) if exc.existing else None)
        except ExecutionError as exc:
            return _error(_STATUS_BY_CODE.get(exc.code, 409), exc.code, exc.message)
        finally:
            session.close()
        background.add_task(_run_execution_job, workspace_id, reservation)
        return JSONResponse(status_code=202, content={"execution": execution_dict(view)})

    @router.get("/action-plans/{artifact_id}/executions", response_model=None)
    def list_executions(request: Request, artifact_id: int):
        workspace_id, err = workspace_or_error(request)
        if err is not None:
            return err
        session = get_session()
        try:
            rows = ToolExecutionService(session, workspace_id).list_for_plan(artifact_id)
            return {"executions": [execution_dict(e) for e in rows]}
        except ExecutionError as exc:
            return _error(_STATUS_BY_CODE.get(exc.code, 409), exc.code, exc.message)
        finally:
            session.close()

    @router.get("/tool-executions/{execution_id}", response_model=None)
    def get_execution(request: Request, execution_id: int):
        workspace_id, err = workspace_or_error(request)
        if err is not None:
            return err
        session = get_session()
        try:
            return {"execution": execution_dict(ToolExecutionService(session, workspace_id).get(execution_id))}
        except ExecutionError as exc:
            return _error(_STATUS_BY_CODE.get(exc.code, 409), exc.code, exc.message)
        finally:
            session.close()

    return router


