"""Re-review findings (external tools): archive/restore, ambiguous rejection, production gate.

Written against the pre-fix code and run there first; each reproduction
failed. Fake transport, scripted planner, temporary SQLite. No network.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlalchemy import select, update
from sqlalchemy.orm import Session

import app.routers.action_plans as router_mod
from app import config
from app.ai.action_plan import TOOL_CALENDAR
from app.db import models
from app.tools.composio_http import ComposioHttpTransport
from app.tools.fake_transport import FakeToolTransport
from app.tools.transport import LinkResult, ToolOutcomeUnknownError
from tests.test_external_tools import (  # noqa: F401  (fixture import)
    HDRS,
    approve,
    connect,
    env,
    execute,
    plan,
    plan_view,
    planned,
    revision,
)

REAL_JOB = router_mod._run_execution_job


def capture(monkeypatch):
    jobs: list = []
    monkeypatch.setattr(router_mod, "_run_execution_job", lambda ws, res: jobs.append((ws, res)))
    return jobs


def release(jobs):
    for ws, res in jobs:
        REAL_JOB(ws, res)
    jobs.clear()


def statuses(eng):
    with Session(eng) as s:
        return [r.status for r in s.scalars(select(models.ToolExecution).order_by(models.ToolExecution.id))]


def archive(c, sid):
    assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200


def restore(c, sid):
    assert c.post(f"/api/screenshots/{sid}/restore", headers=HDRS).status_code == 200


# ================================================================ Fix 1
def test_reserve_archive_restore_release_never_dispatches(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture(monkeypatch)
    assert execute(c, view).status_code == 202
    archive(c, sid)
    assert statuses(eng) == ["cancelled"]  # cancelled in the archive transaction itself
    restore(c, sid)
    release(jobs)
    assert fake.executions == [] and statuses(eng) == ["cancelled"]


def test_archive_racing_dispatch_inside_the_provider_check_window(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture(monkeypatch)
    execute(c, view)
    real = fake.get_connected_account

    def archive_and_restore_during_check(account_id):
        info = real(account_id)
        archive(c, sid)
        restore(c, sid)
        return info

    monkeypatch.setattr(fake, "get_connected_account", archive_and_restore_during_check)
    release(jobs)
    assert fake.executions == [] and statuses(eng) == ["cancelled"]


def test_restore_then_a_new_explicit_run_is_required_and_works(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture(monkeypatch)
    execute(c, view)
    archive(c, sid)
    restore(c, sid)
    release(jobs)
    assert fake.executions == []
    monkeypatch.setattr(router_mod, "_run_execution_job", REAL_JOB)
    assert execute(c, view).status_code == 202  # new Run, re-authorized against the current approval
    assert len(fake.executions) == 1 and statuses(eng) == ["cancelled", "succeeded"]


def test_archive_leaves_executing_rows_alone(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture(monkeypatch)
    execute(c, view)
    real = fake.execute_tool

    def archive_mid_flight(slug, **kw):
        assert statuses(eng) == ["executing"]
        archive(c, sid)
        assert statuses(eng) == ["executing"]  # past the linearization point: not cancellable
        return real(slug, **kw)

    monkeypatch.setattr(fake, "execute_tool", archive_mid_flight)
    release(jobs)
    assert len(fake.executions) == 1 and statuses(eng) == ["succeeded"]


# ================================================================ Fix 2
def _http(response):
    return ComposioHttpTransport(api_key="k", base_url="https://backend.composio.dev", timeout_seconds=5,
                                 client=httpx.Client(transport=httpx.MockTransport(lambda r: response)))


def test_http_200_successful_false_is_unknown():
    t = _http(httpx.Response(200, json={"successful": False, "data": {}, "error": "upstream timeout"}))
    with pytest.raises(ToolOutcomeUnknownError):
        t.execute_tool(TOOL_CALENDAR, user_id="u", connected_account_id="ca_1", version="v", arguments={})


@pytest.mark.parametrize("status", [400, 401, 403, 404, 405, 413, 415, 422])
def test_http_client_errors_on_a_write_are_unknown(status):
    with pytest.raises(ToolOutcomeUnknownError):
        _http(httpx.Response(status)).execute_tool(TOOL_CALENDAR, user_id="u", connected_account_id="ca_1",
                                                   version="v", arguments={})


def _ambiguous(c, planner, fake):
    sid, view = planned(c, planner, "event")
    approve(c, view)
    fake.next_outcome = "rejected"  # the app answered successful: false
    execute(c, view)
    e = c.get(f"/api/action-plans/{view['artifactId']}/executions").json()["executions"][0]
    assert e["status"] == "unknown"
    return sid, view


def test_utc_versus_etc_utc_edit_does_not_bypass(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    v2 = revision(c, view, {0: {"time_zone": "UTC"}}).json()
    approve(c, v2)
    fake.next_outcome = "rejected"
    execute(c, v2)
    v3 = revision(c, v2, {0: {"time_zone": "Etc/UTC"}}).json()
    approve(c, v3)
    assert execute(c, v3).json()["error"]["code"] == "already_executed"
    assert len(fake.executions) == 1


def test_replan_and_reapproval_after_ambiguity_are_blocked(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = _ambiguous(c, planner, fake)
    v2 = plan_view(c, plan(c, sid, replan=True)["artifactId"])
    v3 = revision(c, v2, {0: {"start_date": "2026-12-04", "end_date": "2026-12-04"}}).json()
    approve(c, v3)
    assert execute(c, v3).json()["error"]["code"] == "already_executed"
    assert len(fake.executions) == 1


def test_disconnect_and_reconnect_after_ambiguity_are_blocked(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = _ambiguous(c, planner, fake)
    c.post("/api/integrations/googlecalendar/disconnect", headers=HDRS)
    connect(c, "googlecalendar")
    v2 = revision(c, view).json()  # re-bound to the new account
    assert v2["actions"][0]["destination"]["connectionId"] != view["actions"][0]["destination"]["connectionId"]
    approve(c, v2)
    assert execute(c, v2).json()["error"]["code"] == "already_executed"
    assert len(fake.executions) == 1


def test_proven_non_dispatch_still_allows_retry(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    fake.next_outcome = "not_sent"
    execute(c, view)
    assert execute(c, view).status_code == 202
    assert len(fake.executions) == 1


# ================================================================ Fix 3
def test_attempt_created_before_the_production_gate_cannot_complete(env, monkeypatch):
    make_client, eng, _planner, fake = env
    monkeypatch.setattr(config, "COMPOSIO_CALLBACK_URL", "http://localhost:5173/?view=world")
    links: list[str] = []
    original = FakeToolTransport.create_link

    def hosted_link(**kw):
        links.append(kw["callback_url"])
        res = original(fake, **kw)
        return LinkResult(res.connected_account_id, "https://connect.composio.dev/link/lk_1")

    monkeypatch.setattr(fake, "create_link", hosted_link)
    c = make_client()
    monkeypatch.setattr(config, "EXTERNAL_TOOLS_MODE", "composio")
    monkeypatch.setattr(config, "COMPOSIO_AUTH_CONFIGS", {"notion": "ac_2"})
    fake.mode = "composio"
    assert c.post("/api/integrations/notion/connect", headers=HDRS).json()["connection"]["status"] == "pending"
    token = parse_qs(urlsplit(links[0]).query)["sg_attempt"][0]
    # The restriction is switched on afterwards.
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    monkeypatch.setattr(config, "COMPOSIO_PUBLIC_CONNECT", False)
    r = c.post("/api/integrations/callback", headers=HDRS, json={"attempt": token})
    assert r.status_code == 409 and r.json()["error"]["code"] == "public_connect_disabled"
    assert c.post("/api/integrations/notion/refresh", headers=HDRS).json()["connection"]["status"] != "active"
    assert c.post("/api/integrations/notion/connect", headers=HDRS).json()["error"]["code"] == "public_connect_disabled"
    with Session(eng) as s:
        row = s.scalars(select(models.ToolConnection)).one()
        assert row.status != "active" and row.attempt_consumed_at is None
