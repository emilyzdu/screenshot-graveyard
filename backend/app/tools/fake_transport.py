"""A deterministic, network-free stand-in for Composio (EXTERNAL_TOOLS_MODE=fake).

It imports no HTTP client and opens no socket. Connections become ACTIVE
immediately (no hosted page), tool schemas mirror the catalog, and executions
return a simulated receipt. Everything it produces is recorded as ``fake`` and
shown as simulated: nothing here is ever presented as a real account or a
real delivery.

Tests drive edge cases through the public hooks: ``revoke`` (an account
revoked at the provider), ``next_outcome`` (``rejected``, ``unknown``,
``not_sent``, ``no_id``, ``wrong_owner``) and the ``executions`` log of the
exact arguments that would have been sent.
"""
from __future__ import annotations

import copy
import threading
from typing import Any

from app.tools.catalog import CATALOG
from app.tools.transport import (
    AccountInfo,
    ExecuteResult,
    LinkResult,
    ToolInfo,
    ToolNotFoundError,
    ToolNotSentError,
    ToolOutcomeUnknownError,
    ToolRejectedError,
)

FAKE_TOOLKIT_VERSION = "fake-1"


class FakeToolTransport:
    mode = "fake"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._accounts: dict[str, dict[str, Any]] = {}
        self._counter = 0
        self.next_outcome: str | None = None
        self.executions: list[dict[str, Any]] = []
        self.deleted: list[str] = []
        self.calls: list[str] = []

    def _next(self, prefix: str) -> str:
        self._counter += 1
        return f"{prefix}{self._counter}"

    # ------------------------------------------------------------ accounts
    def create_link(self, *, user_id: str, toolkit: str, auth_config_id: str | None,
                    callback_url: str | None) -> LinkResult:
        with self._lock:
            self.calls.append("create_link")
            account_id = self._next("fake_ca_")
            self._accounts[account_id] = {"user_id": user_id, "toolkit": toolkit, "status": "ACTIVE"}
            return LinkResult(connected_account_id=account_id, redirect_url=None)

    def get_connected_account(self, connected_account_id: str) -> AccountInfo:
        with self._lock:
            self.calls.append("get_connected_account")
            account = self._accounts.get(connected_account_id)
            if account is None:
                raise ToolNotFoundError(status_code=404)
            return AccountInfo(connected_account_id, account["user_id"], account["toolkit"], account["status"], False)

    def delete_connected_account(self, connected_account_id: str) -> None:
        with self._lock:
            self.calls.append("delete_connected_account")
            if self._accounts.pop(connected_account_id, None) is None:
                raise ToolNotFoundError(status_code=404)
            self.deleted.append(connected_account_id)

    # Test hooks ------------------------------------------------------------
    def revoke(self, connected_account_id: str) -> None:
        with self._lock:
            self._accounts[connected_account_id]["status"] = "REVOKED"

    def reassign(self, connected_account_id: str, user_id: str) -> None:
        with self._lock:
            self._accounts[connected_account_id]["user_id"] = user_id

    # --------------------------------------------------------------- tools
    def get_tool(self, slug: str, version: str | None) -> ToolInfo:
        self.calls.append("get_tool")
        tool = CATALOG.get(slug)
        if tool is None:
            raise ToolNotFoundError(status_code=404)
        return ToolInfo(slug=slug, toolkit=tool.toolkit, version=version or FAKE_TOOLKIT_VERSION,
                        input_properties=tool.argument_keys, deprecated=False, tags=frozenset({"createHint"}))

    def execute_tool(self, slug: str, *, user_id: str, connected_account_id: str, version: str,
                     arguments: dict[str, Any]) -> ExecuteResult:
        with self._lock:
            self.calls.append("execute_tool")
            outcome, self.next_outcome = self.next_outcome, None
            record = {"slug": slug, "user_id": user_id, "connected_account_id": connected_account_id,
                      "version": version, "arguments": copy.deepcopy(arguments)}
            if outcome == "not_sent":
                raise ToolNotSentError()
            self.executions.append(record)
            if outcome == "rejected":
                raise ToolRejectedError()
            if outcome == "unknown":
                raise ToolOutcomeUnknownError()
            account = self._accounts.get(connected_account_id)
            if account is None or account["status"] != "ACTIVE" or account["user_id"] != user_id:
                raise ToolRejectedError(status_code=400)
            item_id = self._next("fake_item_")
            if outcome == "no_id":
                return ExecuteResult(data={"response_data": {}}, log_id=self._next("fake_log_"))
            data: dict[str, Any] = {"id": item_id}
            if slug == "GOOGLECALENDAR_CREATE_EVENT":
                data = {"id": item_id, "extendedProperties": copy.deepcopy(arguments.get("extended_properties"))}
            if outcome == "no_marker":
                data.pop("extendedProperties", None)
            if outcome == "wrong_marker":
                data["extendedProperties"] = {"private": {"sgDeliveryKey": "someone-else"}}
            return ExecuteResult(data={"response_data": data}, log_id=self._next("fake_log_"))


_shared: FakeToolTransport | None = None
_shared_lock = threading.Lock()


def shared_fake_transport() -> FakeToolTransport:
    """One process-wide fake so simulated connections persist across requests."""
    global _shared
    with _shared_lock:
        if _shared is None:
            _shared = FakeToolTransport()
        return _shared
