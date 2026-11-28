"""Version-specific approval routes (Batch 5B).

  * GET  /api/artifacts/{artifactId}/approval
        Approval history and the CURRENT version's eligibility. Read-only.
        200 {artifactId, kind, currentVersionId, currentVersionNumber,
             status: current_approved | older_approved | never_approved,
             approvals: [...], eligibility: {eligible, reasons, requiredAcknowledgements, aiOriginFields}}
  * POST /api/artifacts/{artifactId}/approvals   (CSRF-guarded)
        body {"versionId", "confirmReviewed": true, "acknowledgeUncertain": [...]}
        201 created / 200 existing, {"approval": {...}, "approvalResult": ...}
        404 not_found, 409 version_conflict / screenshot_archived / not_approvable /
        acknowledgement_required, 422 malformed body, 503

Only Notes and Calendar drafts can be approved; any other artifact is 404.
Approval records the decision only: it never changes a version, calls an AI
adapter, exports, or writes to any external application.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr, field_validator

from app.db.session import get_session
from app.routers.study_note_artifacts import conflict_response
from app.services.approval_service import (
    ApprovalAcknowledgementError,
    ApprovalNotEligibleError,
    ApprovalNotFoundError,
    ApprovalRecord,
    ApprovalService,
    ApprovalUnavailableError,
)
from app.services.draft_versioning import DraftSourceArchivedError, DraftVersionConflictError


class ApprovalBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    versionId: StrictInt = Field(gt=0)
    # The user must explicitly confirm they reviewed this saved version: only the
    # JSON boolean true is accepted (StrictBool rejects 1, 1.0, "true", null...).
    confirmReviewed: StrictBool
    acknowledgeUncertain: list[StrictStr] = Field(default_factory=list, max_length=32)

    @field_validator("confirmReviewed")
    @classmethod
    def _must_be_true(cls, v: bool) -> bool:
        if v is not True:
            raise ValueError("confirmReviewed must be true")
        return v


def _error(status_code: int, code: str, message: str, **extra) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message, **extra}})


def _workspace(request: Request):
    if getattr(request.state, "identity_unavailable", False):
        return None, _error(503, "identity_unavailable", "Service temporarily unavailable")
    workspace_id = getattr(request.state, "workspace_id", None)
    if workspace_id is None:
        return None, _error(401, "no_workspace", "No workspace")
    return workspace_id, None


def _record_dict(r: ApprovalRecord) -> dict:
    return {
        "approvalId": r.approval_id,
        "artifactId": r.artifact_id,
        "versionId": r.version_id,
        "versionNumber": r.version_number,
        "approvedAt": r.approved_at,
        # There are no user accounts: the approver is this browser's private workspace.
        "approvedBy": "workspace",
        "acknowledgedUncertain": r.acknowledged_uncertain,
        "aiOriginFields": r.ai_origin_fields,
    }


def build_approvals_router() -> APIRouter:
    router = APIRouter(prefix="/api/artifacts", tags=["approvals"])

    @router.get("/{artifact_id}/approval", response_model=None)
    def approval_status(request: Request, artifact_id: int):
        workspace_id, err = _workspace(request)
        if err is not None:
            return err
        session = get_session()
        try:
            s = ApprovalService(session, workspace_id).status(artifact_id)
        except ApprovalNotFoundError:
            return _error(404, "not_found", "Not Found")
        except ApprovalUnavailableError:
            return _error(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()
        return {
            "artifactId": s.artifact_id,
            "kind": s.kind,
            "currentVersionId": s.current_version_id,
            "currentVersionNumber": s.current_version_number,
            "status": s.status,
            "approvals": [_record_dict(a) for a in s.approvals],
            "eligibility": {
                "eligible": s.eligibility.eligible,
                "reasons": s.eligibility.reasons,
                "requiredAcknowledgements": s.eligibility.uncertain,
                "aiOriginFields": s.eligibility.ai_origin_fields,
            },
        }

    @router.post("/{artifact_id}/approvals", response_model=None)
    def approve_version(request: Request, artifact_id: int, body: ApprovalBody):
        """CSRF middleware protects this state-changing, insert-only write."""
        workspace_id, err = _workspace(request)
        if err is not None:
            return err
        session = get_session()
        try:
            record, result = ApprovalService(session, workspace_id).approve(
                artifact_id, body.versionId, list(body.acknowledgeUncertain)
            )
        except ApprovalNotFoundError:
            return _error(404, "not_found", "Not Found")
        except DraftVersionConflictError as exc:
            return conflict_response(exc)
        except DraftSourceArchivedError:
            return _error(409, "screenshot_archived", "Resurrect the source screenshot before approving its draft")
        except ApprovalNotEligibleError as exc:
            return _error(409, "not_approvable", "This version cannot be approved yet", reasons=exc.reasons)
        except ApprovalAcknowledgementError as exc:
            return _error(409, "acknowledgement_required", "Uncertain content must be acknowledged",
                          requiredAcknowledgements=exc.required)
        except ApprovalUnavailableError:
            return _error(503, "service_unavailable", "Service temporarily unavailable")
        finally:
            session.close()
        code = status.HTTP_201_CREATED if result == "created" else status.HTTP_200_OK
        return JSONResponse(status_code=code, content={"approval": _record_dict(record), "approvalResult": result})

    return router
