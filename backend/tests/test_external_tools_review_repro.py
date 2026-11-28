"""Reproductions of the seven Codex review findings (external tools).

Each test states the finding it reproduces. They were written against the
pre-remediation code and failed there (see the remediation report); they must
pass after the fix. Same harness as ``test_external_tools.py``: fake transport,
scripted planner, in-memory SQLite, no network.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

import app.routers.action_plans as router_mod
from app import config
from app.ai.action_plan import TOOL_CALENDAR, TOOL_NOTION
from app.db import models
from app.services.tool_execution_service import ToolExecutionService
from app.tools.composio_http import ComposioHttpTransport
from app.tools.transport import LinkResult, ToolOutcomeUnknownError
from tests.test_external_tools import (  # noqa: F401  (pytest fixture import)
    HDRS,
    UUID,
    approve,
    connect,
    env,
    execute,
    plan,
    plan_view,
    planned,
    revision,
    upload,
)


def _capture_jobs(monkeypatch):
    jobs = []
    monkeypatch.setattr(router_mod, "_run_execution_job", lambda ws, res: jobs.append((ws, res)))
    return jobs


def _run(jobs):
    for ws, res in jobs:
        router_mod.__dict__["_run_execution_job_real"](ws, res)


@pytest.fixture()
def real_job():
    # Keep a handle on the real background body so a test can run it later.
    router_mod.__dict__.setdefault("_run_execution_job_real", router_mod._run_execution_job)
    return router_mod.__dict__["_run_execution_job_real"]


# Finding 1 -----------------------------------------------------------------
@pytest.mark.parametrize("stop", ["disconnect", "archive", "revise"])
def test_f1_reserved_execution_does_not_dispatch_after_a_stop_operation(env, monkeypatch, real_job, stop):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = _capture_jobs(monkeypatch)
    assert execute(c, view).status_code == 202
    if stop == "disconnect":
        c.post("/api/integrations/googlecalendar/disconnect", headers=HDRS)
    elif stop == "archive":
        assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200
    else:
        assert revision(c, view, {0: {"title": "Lab meeting (moved)"}}).status_code == 201
    for ws, res in jobs:
        real_job(ws, res)
    assert fake.executions == []


# Finding 2 -----------------------------------------------------------------
def test_f2_http_408_is_an_unknown_outcome_not_a_retryable_failure():
    t = ComposioHttpTransport(api_key="k", base_url="https://backend.composio.dev", timeout_seconds=5,
                              client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(408))))
    with pytest.raises(ToolOutcomeUnknownError):
        t.execute_tool(TOOL_NOTION, user_id="u", connected_account_id="ca_1", version="v", arguments={})


# Finding 3 -----------------------------------------------------------------
def test_f3_replanning_cannot_bypass_duplicate_protection(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    assert execute(c, view).status_code == 202
    op = plan(c, sid, replan=True)
    v2 = plan_view(c, op["artifactId"])
    assert v2["artifactId"] != view["artifactId"]
    approve(c, v2)
    r = execute(c, v2)
    assert r.status_code == 409 and r.json()["error"]["code"] == "already_executed"
    assert len(fake.executions) == 1


# Finding 4 -----------------------------------------------------------------
def test_f4_documented_flat_input_parameters_are_accepted():
    body = {  # shape of the documented v3.1 GET /tools/{tool_slug} response (flat input_parameters)
        "slug": TOOL_NOTION, "name": "Create Notion page", "description": "d",
        "toolkit": {"slug": "notion", "name": "Notion", "logo": "https://x"},
        "input_parameters": {"title": {"type": "string"}, "parent_id": {"type": "string"}, "markdown": {"type": "string"}},
        "no_auth": False, "available_versions": ["20251201_00"], "version": "20251201_00",
        "output_parameters": {}, "scopes": [], "scope_requirements": None, "tags": ["createHint"],
        "is_deprecated": False, "deprecated": {},
    }
    t = ComposioHttpTransport(api_key="k", base_url="https://backend.composio.dev", timeout_seconds=5,
                              client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, json=body))))
    info = t.get_tool(TOOL_NOTION, None)
    assert {"title", "parent_id", "markdown"} <= info.input_properties


# Finding 5 -----------------------------------------------------------------
def test_f5_stale_settlement_never_overwrites_a_confirmed_success(env, monkeypatch, real_job):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = _capture_jobs(monkeypatch)
    execute(c, view)
    with Session(eng) as s:
        row = s.scalars(select(models.ToolExecution)).one()
        row.status = "executing"
        old = datetime.now(timezone.utc) - timedelta(seconds=config.TOOL_EXECUTION_STALE_SECONDS + 5)
        row.updated_at = old
        if hasattr(row, "dispatched_at"):
            row.dispatched_at = old
        s.commit()
        ws_id = row.workspace_id
        art = row.artifact_id
        exec_id = row.id
    # Exact race: session A detects the row as overdue, then (before it takes
    # the workspace lock) session B records the confirmed success.
    a = Session(eng, expire_on_commit=False)
    svc = ToolExecutionService(a, ws_id, transport=fake)
    real_lock = svc._repo.lock_workspace

    def success_lands_first():
        with Session(eng) as b:
            r = b.get(models.ToolExecution, exec_id)
            r.status, r.external_id = "succeeded", "evt_ok"
            b.commit()
        return real_lock()

    monkeypatch.setattr(svc._repo, "lock_workspace", success_lands_first)
    svc._settle_stale(art)
    a.close()
    with Session(eng) as s:
        assert s.get(models.ToolExecution, exec_id).status == "succeeded"


# Finding 6 -----------------------------------------------------------------
def test_f6_calendar_item_id_without_our_marker_is_not_success(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    fake.next_outcome = "no_marker"
    execute(c, view)
    e = c.get(f"/api/action-plans/{view['artifactId']}/executions").json()["executions"][0]
    assert e["status"] == "unknown" and e["receipt"] is None
    assert execute(c, view).json()["error"]["code"] == "already_executed"


# Finding 7 -----------------------------------------------------------------
def test_f7_provider_status_alone_cannot_complete_a_hosted_connection(env, monkeypatch):
    make_client, _eng, _planner, fake = env
    monkeypatch.setattr(config, "COMPOSIO_CALLBACK_URL", "http://localhost:5173/?view=world")

    def hosted_link(**kw):
        res = type(fake).create_link(fake, **kw)
        return LinkResult(res.connected_account_id, "https://connect.composio.dev/link/abc")

    monkeypatch.setattr(fake, "create_link", hosted_link)
    victim, attacker = make_client(), make_client()
    r = victim.post("/api/integrations/googlecalendar/connect", headers=HDRS).json()
    assert r["connection"]["status"] == "pending"
    # Someone completes the hosted page; Composio now reports the account ACTIVE.
    # Without the initiating browser returning with its single-use attempt, the
    # workspace must not start using it.
    s = victim.post("/api/integrations/googlecalendar/refresh", headers=HDRS).json()
    assert s["connection"]["status"] != "active"
    # A callback presented by another workspace is never accepted.
    bad = attacker.post("/api/integrations/callback", headers=HDRS,
                        json={"attempt": "x" * 43, "connectedAccountId": "fake_ca_1"})
    assert bad.status_code in (400, 404)
