"""Connected applications (Composio connected accounts) for the current workspace.

  * GET  /api/integrations                      mode + every supported toolkit's status
  * POST /api/integrations/{toolkit}/connect     start (or reuse) a hosted connection
  * POST /api/integrations/{toolkit}/refresh     re-read the status from the provider
  * POST /api/integrations/{toolkit}/disconnect  stop using it, then delete it remotely

POSTs are CSRF-guarded by the middleware. Responses never contain the API key,
the provider user id or a connected account id: the browser gets a status, a
local connection number and, for a new connection, the hosted (https) URL.
Composio's redirect back to the app carries query parameters that are ignored;
the app calls ``refresh`` and the server asks the provider itself.
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictStr

from app import config
from app.db.session import get_session
from app.services.tool_connection_service import (
    ConnectionAttemptError,
    ConnectionUnavailableError,
    PublicConnectDisabledError,
    ConnectionView,
    ToolConnectionService,
    ToolkitNotConfiguredError,
    ToolkitNotFoundError,
    ToolsDisabledError,
)


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


def workspace_or_error(request: Request):
    if getattr(request.state, "identity_unavailable", False):
        return None, _error(503, "identity_unavailable", "Service temporarily unavailable")
    workspace_id = getattr(request.state, "workspace_id", None)
    if workspace_id is None:
        return None, _error(401, "no_workspace", "No workspace")
    return workspace_id, None


def connection_dict(v: ConnectionView) -> dict:
    return {
        "toolkit": v.toolkit,
        "label": v.label,
        "configured": v.configured,
        "status": v.status,
        "connectionId": v.connection_id,
        "simulated": v.simulated,
        "tools": v.tools,
        "liveVerifiedTools": v.live_verified_tools,
    }


def tools_status() -> dict:
    mode = config.EXTERNAL_TOOLS_MODE
    return {
        "mode": mode,
        "enabled": mode != "off",
        "simulated": mode == "fake",
        "liveWrites": mode == "composio" and config.COMPOSIO_ALLOW_LIVE_WRITES,
    }


class CallbackBody(BaseModel):
    model_config = ConfigDict(extra="ignore")  # Composio may append other parameters
    attempt: StrictStr = Field(min_length=20, max_length=128)
    connectedAccountId: StrictStr | None = Field(default=None, max_length=128)


def build_integrations_router() -> APIRouter:
    router = APIRouter(prefix="/api/integrations", tags=["integrations"])

    def _run(request: Request, work):
        workspace_id, err = workspace_or_error(request)
        if err is not None:
            return err
        session = get_session()
        try:
            return work(ToolConnectionService(session, workspace_id))
        except ToolsDisabledError:
            return _error(409, "tools_disabled", "External apps are not enabled on this server")
        except ToolkitNotFoundError:
            return _error(404, "not_found", "Not Found")
        except ToolkitNotConfiguredError:
            return _error(409, "toolkit_not_configured", "This app is not set up on this server")
        except PublicConnectDisabledError:
            return _error(409, "public_connect_disabled",
                          "Connecting real accounts is limited to local test setups on this server")
        except ConnectionAttemptError:
            return _error(400, "invalid_attempt", "This connection link is not valid for this browser, was already used, or expired")
        except ConnectionUnavailableError:
            return _error(503, "service_unavailable", "The app connection service is unavailable; nothing changed")
        finally:
            session.close()

    @router.get("", response_model=None)
    def list_integrations(request: Request):
        return _run(request, lambda s: {**tools_status(), "toolkits": [connection_dict(v) for v in s.list()]})

    @router.post("/{toolkit}/connect", response_model=None)
    def connect(request: Request, toolkit: str):
        def work(s: ToolConnectionService):
            view, url = s.connect(toolkit)
            return {"connection": connection_dict(view), "redirectUrl": url}
        return _run(request, work)

    @router.post("/callback", response_model=None)
    def complete(request: Request, body: CallbackBody):
        """The browser returning from the hosted page presents its single-use attempt."""
        return _run(request, lambda s: {"connection": connection_dict(s.complete(body.attempt, body.connectedAccountId))})

    @router.post("/{toolkit}/refresh", response_model=None)
    def refresh(request: Request, toolkit: str):
        return _run(request, lambda s: {"connection": connection_dict(s.refresh(toolkit))})

    @router.post("/{toolkit}/disconnect", response_model=None)
    def disconnect(request: Request, toolkit: str):
        def work(s: ToolConnectionService):
            view, removed = s.disconnect(toolkit)
            return {"connection": connection_dict(view), "removedAtProvider": removed}
        return _run(request, work)

    return router
