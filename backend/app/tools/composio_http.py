"""Composio REST v3.1 transport (backend only).

Why REST instead of the ``composio`` Python SDK: every SDK release since
0.20 requires ``openai>=2.48`` (0.35.0: ``openai<4,>=2.48.0``), and this
backend pins ``openai==1.109.1`` for its reviewed vision adapter. Installing
the SDK would force a two-major upgrade of that adapter. The endpoints used
here are the ones the SDK itself calls (``composio-client`` 2.1.36):

* ``POST   /api/v3.1/connected_accounts/link``        hosted Connect Link
* ``GET    /api/v3.1/connected_accounts/{id}``        status + owner check
* ``DELETE /api/v3.1/connected_accounts/{id}``        disconnect
* ``GET    /api/v3.1/tools/{slug}?version=``          live tool schema
* ``POST   /api/v3.1/tools/execute/{slug}``           execute with an explicit
  ``user_id``, ``connected_account_id`` and pinned ``version``

Direct execution (not a tool-router session) is used on purpose: it lets this
server pin the exact connected account and toolkit version an approval was
bound to. Sessions pick the newest version and, for several accounts, the most
recent one. No meta-tool, workbench, proxy or search endpoint is called.

The API key travels only in the ``x-api-key`` header, is never logged (the
process-wide httpx log redaction drops any line mentioning it) and never
appears in an exception message. No call is retried.
"""
from __future__ import annotations

import re
from typing import Any

import httpx

from app.ai.log_redaction import install_provider_log_redaction
from app.tools.transport import (
    AccountInfo,
    ExecuteResult,
    LinkResult,
    ToolInfo,
    ToolNotFoundError,
    ToolNotSentError,
    ToolOutcomeUnknownError,
    ToolRejectedError,
    ToolTransportError,
)

install_provider_log_redaction()

_PATH_ID = re.compile(r"^[A-Za-z0-9_\-]{1,128}$")
_API = "/api/v3.1"


def parse_input_parameters(raw: object) -> tuple[frozenset[str], frozenset[str]]:
    """``(parameter names, required names)`` from a tool's ``input_parameters``.

    Two shapes are accepted, anything else fails closed:

    * the documented REST v3.1 ``GET /tools/{slug}`` shape: a FLAT map of
      parameter name -> parameter schema (``"required": true`` marks a required
      one);
    * a JSON Schema object (``{"type": "object", "properties": {...},
      "required": [...]}``), the shape the docs pass straight through as
      function ``parameters``.
    """
    if not isinstance(raw, dict) or not raw:
        raise ToolTransportError()
    props = raw.get("properties")
    if raw.get("type") == "object" and isinstance(props, dict):
        required = raw.get("required", [])
        if not isinstance(required, list) or not all(isinstance(r, str) for r in required):
            raise ToolTransportError()
        names = frozenset(k for k in props if isinstance(k, str))
        if not set(required) <= names:
            raise ToolTransportError()
        return names, frozenset(required)
    params = {k: v for k, v in raw.items() if isinstance(k, str) and (isinstance(v, dict) or v is None)}
    if len(params) != len(raw):
        raise ToolTransportError()  # not a recognizable parameter map
    required = frozenset(k for k, v in params.items() if isinstance(v, dict) and v.get("required") is True)
    return frozenset(params), required


def _path_id(value: str) -> str:
    """Only plain identifiers are ever interpolated into a URL path."""
    if not isinstance(value, str) or not _PATH_ID.fullmatch(value):
        raise ToolRejectedError("invalid identifier")
    return value


class ComposioHttpTransport:
    mode = "composio"

    def __init__(self, *, api_key: str, base_url: str, timeout_seconds: float,
                 client: httpx.Client | None = None) -> None:
        if not api_key or not api_key.strip():
            raise RuntimeError("COMPOSIO_API_KEY is required for EXTERNAL_TOOLS_MODE=composio")
        if not base_url.startswith("https://"):
            raise RuntimeError("COMPOSIO_BASE_URL must be https")
        self._base = base_url.rstrip("/")
        self._headers = {"x-api-key": api_key.strip(), "Accept": "application/json"}
        self._client = client or httpx.Client(timeout=timeout_seconds, follow_redirects=False)

    # ------------------------------------------------------------- plumbing
    def _send(self, method: str, path: str, *, json: dict | None = None, params: dict | None = None,
              write: bool = False) -> dict[str, Any]:
        try:
            response = self._client.request(method, self._base + path, headers=self._headers,
                                            json=json, params=params)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            # No connection was established, so no request byte left this
            # process. The ONLY case in which a write is known not to be sent.
            raise ToolNotSentError() from None
        except httpx.HTTPError:
            # Write/read timeout, dropped connection, protocol error: the
            # request may have been received and performed.
            if write:
                raise ToolOutcomeUnknownError() from None
            raise ToolTransportError() from None
        status = response.status_code
        if write and not 200 <= status < 300:
            # The request reached Composio. No status code (4xx included) is
            # reliable proof that the tool did not run, so every one is an
            # unknown outcome: never reported as "not sent", never retried.
            raise ToolOutcomeUnknownError()
        if status == 404:
            raise ToolNotFoundError(status_code=404)
        if 400 <= status < 500:
            raise ToolRejectedError(status_code=status)
        if status >= 500 or status < 200 or status >= 300:
            raise ToolTransportError()
        try:
            body = response.json()
        except ValueError:
            if write:
                raise ToolOutcomeUnknownError() from None
            raise ToolTransportError() from None
        if not isinstance(body, dict):
            if write:
                raise ToolOutcomeUnknownError()
            raise ToolTransportError()
        return body

    # ------------------------------------------------------------ accounts
    def create_link(self, *, user_id: str, toolkit: str, auth_config_id: str | None,
                    callback_url: str | None) -> LinkResult:
        if not auth_config_id:
            raise ToolRejectedError("toolkit not configured")
        payload: dict[str, Any] = {"auth_config_id": _path_id(auth_config_id), "user_id": user_id}
        if callback_url:
            payload["callback_url"] = callback_url
        body = self._send("POST", f"{_API}/connected_accounts/link", json=payload)
        account_id, url = body.get("connected_account_id"), body.get("redirect_url")
        if not isinstance(account_id, str) or not _PATH_ID.fullmatch(account_id):
            raise ToolTransportError()
        if not isinstance(url, str) or not url.startswith("https://"):
            raise ToolTransportError()
        return LinkResult(connected_account_id=account_id, redirect_url=url)

    def get_connected_account(self, connected_account_id: str) -> AccountInfo:
        body = self._send("GET", f"{_API}/connected_accounts/{_path_id(connected_account_id)}")
        toolkit = body.get("toolkit") if isinstance(body.get("toolkit"), dict) else {}
        values = (body.get("id"), body.get("user_id"), toolkit.get("slug"), body.get("status"))
        if not all(isinstance(v, str) and v for v in values):
            raise ToolTransportError()
        return AccountInfo(
            connected_account_id=values[0],
            user_id=values[1],
            toolkit=values[2].lower(),
            status=values[3].upper(),
            disabled=body.get("is_disabled") is not False,
        )

    def delete_connected_account(self, connected_account_id: str) -> None:
        body = self._send("DELETE", f"{_API}/connected_accounts/{_path_id(connected_account_id)}")
        if body.get("success") is not True:
            raise ToolTransportError()

    # --------------------------------------------------------------- tools
    def get_tool(self, slug: str, version: str | None) -> ToolInfo:
        params = {"version": version} if version else None
        body = self._send("GET", f"{_API}/tools/{_path_id(slug)}", params=params)
        names, required = parse_input_parameters(body.get("input_parameters"))
        toolkit = body.get("toolkit") if isinstance(body.get("toolkit"), dict) else {}
        resolved = body.get("version")
        if (
            body.get("slug") != slug
            or not isinstance(resolved, str) or not resolved
            or not isinstance(toolkit.get("slug"), str)
        ):
            raise ToolTransportError()
        tags = body.get("tags") if isinstance(body.get("tags"), list) else []
        versions = body.get("available_versions") if isinstance(body.get("available_versions"), list) else []
        return ToolInfo(
            slug=slug,
            toolkit=toolkit["slug"].lower(),
            version=resolved,
            input_properties=names,
            deprecated=body.get("is_deprecated") is not False,
            tags=frozenset(t for t in tags if isinstance(t, str)),
            required=required,
            available_versions=frozenset(v for v in versions if isinstance(v, str)),
        )

    def execute_tool(self, slug: str, *, user_id: str, connected_account_id: str, version: str,
                     arguments: dict[str, Any]) -> ExecuteResult:
        try:
            account, tool = _path_id(connected_account_id), _path_id(slug)
        except ToolRejectedError:
            raise ToolNotSentError() from None  # refused locally, before any request
        payload = {"user_id": user_id, "connected_account_id": account, "version": version, "arguments": arguments}
        body = self._send("POST", f"{_API}/tools/execute/{tool}", json=payload, write=True)
        successful = body.get("successful")
        data = body.get("data")
        log_id = body.get("log_id") if isinstance(body.get("log_id"), str) else None
        if successful is not True or not isinstance(data, dict):
            # Includes ``successful: false``: the app reported a failure, which
            # does not establish that nothing was created upstream.
            raise ToolOutcomeUnknownError()
        return ExecuteResult(data=data, log_id=log_id)
