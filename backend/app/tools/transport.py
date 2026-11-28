"""The external-tool transport boundary (Composio REST v3.1 or a deterministic fake).

Services depend on this Protocol only. Every error carries a generic, safe
message: no API key, account token, argument value or provider payload.

Outcome classes for an EXECUTE call (the only external write):

* :class:`ToolNotSentError` - the request provably never reached the provider
  (connection refused, DNS failure, or a refusal before dispatch). Safe to try
  again later.
* :class:`ToolRejectedError` - the provider answered and did not perform the
  write (a 4xx from Composio, or ``successful: false`` from the tool).
* :class:`ToolOutcomeUnknownError` - the request may have been performed (read
  timeout, connection dropped after sending, 5xx, unreadable response). Never
  retried automatically.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


class ToolTransportError(Exception):
    detail = "External app unavailable"


class ToolNotSentError(ToolTransportError):
    detail = "Could not reach the external app; nothing was sent"


class ToolRejectedError(ToolTransportError):
    detail = "The external app refused the request"

    def __init__(self, message: str | None = None, *, status_code: int | None = None) -> None:
        super().__init__(message or self.detail)
        self.status_code = status_code


class ToolNotFoundError(ToolRejectedError):
    detail = "Not found at the external app"


class ToolOutcomeUnknownError(ToolTransportError):
    detail = "No reliable answer from the external app; the item may or may not exist"


@dataclass(frozen=True)
class LinkResult:
    connected_account_id: str
    # Hosted authorization page (https). None when no user step is needed (fake).
    redirect_url: str | None


@dataclass(frozen=True)
class AccountInfo:
    connected_account_id: str
    user_id: str
    toolkit: str
    # Provider status, upper case: INITIALIZING, INITIATED, ACTIVE, FAILED,
    # EXPIRED, INACTIVE, REVOKED.
    status: str
    disabled: bool


@dataclass(frozen=True)
class ToolInfo:
    slug: str
    toolkit: str
    version: str
    input_properties: frozenset[str]
    deprecated: bool
    tags: frozenset[str] = field(default_factory=frozenset)
    required: frozenset[str] = field(default_factory=frozenset)
    available_versions: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class ExecuteResult:
    """A provider answer to an execute call that reported success."""

    data: dict[str, Any]
    log_id: str | None


class ToolTransport(Protocol):
    #: ``fake`` or ``composio``; recorded on every connection and execution.
    mode: str

    def create_link(self, *, user_id: str, toolkit: str, auth_config_id: str | None,
                    callback_url: str | None) -> LinkResult: ...

    def get_connected_account(self, connected_account_id: str) -> AccountInfo: ...

    def delete_connected_account(self, connected_account_id: str) -> None: ...

    def get_tool(self, slug: str, version: str | None) -> ToolInfo: ...

    def execute_tool(self, slug: str, *, user_id: str, connected_account_id: str, version: str,
                     arguments: dict[str, Any]) -> ExecuteResult: ...
