"""Regression tests for the external-tools remediation batch (Codex review).

Areas: the dispatch boundary versus disconnect / Safe Burial / plan edits,
response classification, stable delivery identity across replans, the
documented Composio tool schema, stale settlement, receipt correlation,
hosted-connection completion, SQLite concurrency and PostgreSQL DDL/SQL
compatibility (compiled only; no PostgreSQL server was available).
Fake transport, scripted planner, temporary SQLite. No network.
"""
from __future__ import annotations

import os
import threading
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, select, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool
from sqlalchemy.schema import CreateIndex

import app.db.session as sess_mod
import app.routers.action_plans as router_mod
from app import config
from app.ai import provider
from app.ai.action_plan import TOOL_CALENDAR, TOOL_GMAIL, TOOL_NOTION
from app.db import models
from app.db.base import Base
from app.main import create_app
from app.ratelimit import TokenBucketRateLimiter
from app.services import action_plan_service
from app.services.tool_connection_service import ToolConnectionService
from app.services.tool_execution_service import (
    ExecutionDuplicateError,
    Reservation,
    ToolExecutionService,
)
from app.tools import provider as tools_provider
from app.tools.arguments import ReceiptError, extract_receipt
from app.tools.composio_http import ComposioHttpTransport, parse_input_parameters
from app.tools.fake_transport import FakeToolTransport
from app.tools.transport import (
    LinkResult,
    ToolNotSentError,
    ToolOutcomeUnknownError,
    ToolRejectedError,
    ToolTransportError,
)
from tests.test_external_tools import (  # noqa: F401  (fixture import)
    HDRS,
    UUID,
    ScriptedPlanner,
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

REAL_JOB = router_mod._run_execution_job


def capture_jobs(monkeypatch):
    jobs: list = []
    monkeypatch.setattr(router_mod, "_run_execution_job", lambda ws, res: jobs.append((ws, res)))
    return jobs


def run_jobs(jobs):
    for ws, res in jobs:
        REAL_JOB(ws, res)
    jobs.clear()


def rows(eng):
    with Session(eng) as s:
        return list(s.scalars(select(models.ToolExecution).order_by(models.ToolExecution.id)))


def executions(c, view):
    return c.get(f"/api/action-plans/{view['artifactId']}/executions").json()["executions"]


# ================================================ 1. dispatch boundary
def test_disconnect_cancels_unsent_reservations_in_its_own_transaction(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture_jobs(monkeypatch)
    execute(c, view)
    assert rows(eng)[0].status == "reserved"
    c.post("/api/integrations/googlecalendar/disconnect", headers=HDRS)
    assert rows(eng)[0].status == "cancelled"  # before any dispatch attempt
    run_jobs(jobs)
    assert fake.executions == [] and rows(eng)[0].status == "cancelled"


def test_plan_edit_cancels_unsent_reservation(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture_jobs(monkeypatch)
    execute(c, view)
    revision(c, view, {0: {"location": "Room 9"}})
    assert rows(eng)[0].status == "cancelled"
    run_jobs(jobs)
    assert fake.executions == []


def test_archive_between_provider_check_and_lock_cancels(env, monkeypatch):
    """A stop that commits inside the unlocked provider-check window still wins."""
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture_jobs(monkeypatch)
    execute(c, view)
    real = fake.get_connected_account
    calls = {"n": 0}

    def archive_during_check(account_id):
        calls["n"] += 1
        info = real(account_id)
        assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200
        return info

    monkeypatch.setattr(fake, "get_connected_account", archive_during_check)
    run_jobs(jobs)
    assert calls["n"] == 1  # the dispatch boundary asked the provider again
    assert fake.executions == []
    assert rows(eng)[0].status == "cancelled" and "Cancelled before sending" in rows(eng)[0].error_detail


def test_provider_side_revocation_after_reservation_cancels(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture_jobs(monkeypatch)
    execute(c, view)
    fake.reassign("fake_ca_1", "sg_someone_else")  # ownership changed at the provider
    run_jobs(jobs)
    assert fake.executions == [] and rows(eng)[0].status == "cancelled"


def test_dispatch_that_wins_is_not_reported_as_cancelled(env, monkeypatch):
    """After the linearization point a stop cannot undo the remote write."""
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture_jobs(monkeypatch)
    execute(c, view)
    run_jobs(jobs)
    c.post("/api/integrations/googlecalendar/disconnect", headers=HDRS)
    c.post(f"/api/screenshots/{sid}/archive", headers=HDRS)
    assert len(fake.executions) == 1 and rows(eng)[0].status == "succeeded"


def test_stop_committed_after_linearization_does_not_change_the_executing_row(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture_jobs(monkeypatch)
    execute(c, view)
    real = fake.execute_tool

    def disconnect_mid_flight(slug, **kw):
        assert rows(eng)[0].status == "executing"  # the row was committed before the call
        c.post("/api/integrations/googlecalendar/disconnect", headers=HDRS)
        assert rows(eng)[0].status == "executing"  # not cancellable any more
        return real(slug, **kw)

    monkeypatch.setattr(fake, "execute_tool", disconnect_mid_flight)
    run_jobs(jobs)
    # The fake rejects an inactive account, which the app reports as rejected, not cancelled.
    assert rows(eng)[0].status in {"succeeded", "unknown"}


def test_dispatch_rechecks_the_argument_hash(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    jobs = capture_jobs(monkeypatch)
    execute(c, view)
    ws, res = jobs.pop()
    REAL_JOB(ws, Reservation(res.execution_id, {**res.arguments, "summary": "tampered"}))
    assert fake.executions == [] and rows(eng)[0].status == "cancelled"


# ================================================ 2. response classification
def _http(handler):
    return ComposioHttpTransport(api_key="k", base_url="https://backend.composio.dev", timeout_seconds=5,
                                 client=httpx.Client(transport=httpx.MockTransport(handler)))


def _raise(exc):
    def handler(_request):
        raise exc
    return handler


MATRIX = [
    # (name, handler, expected exception or None for success)
    ("200 successful", lambda r: httpx.Response(200, json={"successful": True, "data": {"id": "x"}}), None),
    ("200 successful:false", lambda r: httpx.Response(200, json={"successful": False, "data": {}}), ToolOutcomeUnknownError),
    ("200 not json", lambda r: httpx.Response(200, text="<html>"), ToolOutcomeUnknownError),
    ("200 successful missing", lambda r: httpx.Response(200, json={"data": {}}), ToolOutcomeUnknownError),
    ("204", lambda r: httpx.Response(204), ToolOutcomeUnknownError),
    ("302", lambda r: httpx.Response(302, headers={"location": "https://x"}), ToolOutcomeUnknownError),
    *[(str(s), (lambda s: lambda r: httpx.Response(s))(s), ToolOutcomeUnknownError)
      for s in (400, 401, 403, 404, 405, 413, 415, 422)],
    *[(str(s), (lambda s: lambda r: httpx.Response(s))(s), ToolOutcomeUnknownError)
      for s in (408, 409, 410, 425, 429, 499, 500, 502, 503, 504)],
    ("connect error", _raise(httpx.ConnectError("refused")), ToolNotSentError),
    ("connect timeout", _raise(httpx.ConnectTimeout("t")), ToolNotSentError),
    ("pool timeout", _raise(httpx.PoolTimeout("t")), ToolNotSentError),
    ("read timeout", _raise(httpx.ReadTimeout("t")), ToolOutcomeUnknownError),
    ("write timeout", _raise(httpx.WriteTimeout("t")), ToolOutcomeUnknownError),
    ("write error", _raise(httpx.WriteError("w")), ToolOutcomeUnknownError),
    ("read error", _raise(httpx.ReadError("r")), ToolOutcomeUnknownError),
    ("protocol error", _raise(httpx.RemoteProtocolError("p")), ToolOutcomeUnknownError),
]


@pytest.mark.parametrize("name,handler,expected", MATRIX, ids=[m[0] for m in MATRIX])
def test_write_response_classification_matrix(name, handler, expected):
    t = _http(handler)
    call = lambda: t.execute_tool(TOOL_NOTION, user_id="u", connected_account_id="ca_1", version="v", arguments={})  # noqa: E731
    if expected is None:
        assert call().data == {"id": "x"}
    else:
        with pytest.raises(expected):
            call()


@pytest.mark.parametrize("outcome,status,retry", [
    ("not_sent", "failed", True), ("rejected", "unknown", False), ("unknown", "unknown", False),
])
def test_only_proven_non_dispatch_allows_a_new_run(env, outcome, status, retry):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    fake.next_outcome = outcome
    execute(c, view)
    first = executions(c, view)[0]
    assert first["status"] == status
    if status != "failed":
        assert "nothing was sent" not in (first["detail"] or "").lower()
    r = execute(c, view)
    assert (r.status_code == 202) is retry


# ================================================ 3. stable delivery identity
def _replan(c, sid):
    return plan_view(c, plan(c, sid, replan=True)["artifactId"])


def test_cosmetically_edited_replan_is_still_a_duplicate(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    execute(c, view)
    v2 = _replan(c, sid)
    v3 = revision(c, v2, {0: {"title": "LAB   meeting!!", "description": "Bring slides", "location": "Room 2b"}}).json()
    approve(c, v3)
    assert execute(c, v3).json()["error"]["code"] == "already_executed"
    assert len(fake.executions) == 1
    # The replacement plan surfaces the earlier write.
    hist = plan_view(c, v3["artifactId"])["actions"][0]["deliveryHistory"]
    assert [h["status"] for h in hist] == ["succeeded"] and hist[0]["artifactId"] == view["artifactId"]


def test_distinct_intended_action_runs_once_nothing_is_unresolved(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    execute(c, view)
    v2 = _replan(c, sid)
    v3 = revision(c, v2, {0: {"start_date": "2026-12-10", "end_date": "2026-12-10"}}).json()
    approve(c, v3)
    assert execute(c, v3).status_code == 202
    assert len(fake.executions) == 2


def test_unknown_outcome_blocks_every_action_in_its_scope(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    fake.next_outcome = "unknown"
    execute(c, view)
    v2 = _replan(c, sid)
    v3 = revision(c, v2, {0: {"start_date": "2026-12-10", "end_date": "2026-12-10"}}).json()
    approve(c, v3)
    assert execute(c, v3).json()["error"]["code"] == "already_executed"
    assert len(fake.executions) == 1


def test_not_sent_failure_then_replan_may_run(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    fake.next_outcome = "not_sent"
    execute(c, view)
    v2 = _replan(c, sid)
    approve(c, v2)
    assert execute(c, v2).status_code == 202
    assert len(fake.executions) == 1  # the first attempt never reached the app


def test_notion_identity_is_parent_page_and_normalized_title(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "notes")
    v2 = revision(c, view, {0: {"parent_id": UUID}}).json()
    approve(c, v2)
    execute(c, v2)
    r1 = _replan(c, sid)
    same = revision(c, r1, {0: {"parent_id": UUID.replace("-", "").upper(), "title": "recursion.",
                                "markdown": "other body"}}).json()
    approve(c, same)
    assert execute(c, same).json()["error"]["code"] == "already_executed"
    r2 = _replan(c, sid)
    other = revision(c, r2, {0: {"parent_id": "0" * 32}}).json()
    approve(c, other)
    assert execute(c, other).status_code == 202


def test_partial_unique_indexes_hold_even_without_the_service(env):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    execute(c, view)
    with Session(eng) as s:
        src = s.scalars(select(models.ToolExecution)).one()
        assert src.status == "succeeded"
        clone = {k: getattr(src, k) for k in (
            "workspace_id", "artifact_id", "artifact_version_id", "approval_id", "screenshot_id", "scope_key",
            "action_index", "tool_slug", "toolkit", "toolkit_version", "connection_id", "mode", "delivery_key",
            "arguments_sha256")}
        s.add(models.ToolExecution(**{**clone, "attempt": 2, "status": "reserved"}))
        with pytest.raises(IntegrityError):
            s.commit()  # same delivery identity already succeeded
        s.rollback()
        s.add(models.ToolExecution(**{**clone, "attempt": 2, "status": "reserved", "delivery_key": "d" * 64}))
        s.commit()  # distinct action, scope resolved: allowed
        s.add(models.ToolExecution(**{**clone, "attempt": 3, "status": "reserved", "delivery_key": "e" * 64}))
        with pytest.raises(IntegrityError):
            s.commit()  # a second unresolved execution in the same scope


@pytest.fixture()
def file_env(tmp_path, monkeypatch):
    """File-backed SQLite with independent connections (real locking between threads)."""
    url = f"sqlite:///{tmp_path.as_posix()}/c.db"
    eng = create_engine(url, poolclass=NullPool, connect_args={"check_same_thread": False, "timeout": 30})
    Base.metadata.create_all(eng)
    factory = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False, class_=Session)
    monkeypatch.setattr(sess_mod, "engine", eng)
    monkeypatch.setattr(sess_mod, "SessionLocal", factory)
    monkeypatch.setattr(config, "COOKIE_SECURE", False)
    monkeypatch.setattr(config, "STORAGE_ROOT", str(tmp_path / "storage"))
    monkeypatch.setattr(config, "AI_PROVIDER", "fake")
    monkeypatch.setattr(config, "EXTERNAL_TOOLS_MODE", "fake")
    action_plan_service.clear_catalog_cache()
    saved = provider.get_ai_adapter(), tools_provider.get_tool_transport()
    planner, fake = ScriptedPlanner(), FakeToolTransport()
    app = create_app(workspace_session_factory=factory,
                     rate_limiter=TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0),
                     workspace_rate_limiter=TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0))
    provider.set_ai_adapter(planner)
    tools_provider.set_tool_transport(fake)
    c = TestClient(app)
    c.get("/api/workspace")
    yield c, eng, factory, planner, fake
    provider.set_ai_adapter(saved[0])
    tools_provider.set_tool_transport(saved[1])
    for p in (tmp_path / "storage").rglob("*"):
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass


def test_concurrent_reservations_across_replans_yield_exactly_one(file_env):
    c, eng, factory, planner, fake = file_env
    for t in ("googlecalendar", "notion", "gmail"):
        connect(c, t)
    sid = upload(c)
    planner.scenarios[sid] = "event"
    v1 = plan_view(c, plan(c, sid)["artifactId"])
    v2 = plan_view(c, plan(c, sid, replan=True)["artifactId"])
    approve(c, v1)
    approve(c, v2)
    with Session(eng) as s:
        ws = s.scalars(select(models.Workspace.id)).one()
    barrier = threading.Barrier(2)
    results: list = []

    def reserve(view):
        session = factory()
        try:
            barrier.wait()
            results.append(ToolExecutionService(session, ws, transport=fake).authorize(
                view["artifactId"], view["versionId"], 0, view["contentSha256"]))
        except ExecutionDuplicateError as exc:
            results.append(exc)
        finally:
            session.close()

    threads = [threading.Thread(target=reserve, args=(v,)) for v in (v1, v2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(30)
    assert sorted(type(r).__name__ for r in results) == ["ExecutionDuplicateError", "Reservation"]
    with Session(eng) as s:
        assert len(list(s.scalars(select(models.ToolExecution)))) == 1


# ================================================ 4. Composio tool schema
# Shapes from the official v3.1 reference ("GET /api/v3.1/tools/{tool_slug}":
# input_parameters is an object of `[key: string]` parameter entries) with the
# parameter names published on the toolkit pages.
def _tool_body(slug, toolkit, params, **over):
    body = {"slug": slug, "name": slug, "description": "d",
            "toolkit": {"slug": toolkit, "name": toolkit, "logo": "https://x"},
            "input_parameters": params, "no_auth": False, "available_versions": ["20251201_00"],
            "version": "20251201_00", "output_parameters": {}, "scopes": [], "scope_requirements": None,
            "tags": ["createHint"], "is_deprecated": False, "deprecated": {}}
    body.update(over)
    return body


DOC_FLAT = {
    TOOL_CALENDAR: ("googlecalendar", {k: {"type": "string"} for k in (
        "summary", "end_date", "location", "timezone", "attendees", "eventType", "recurrence", "start_date",
        "visibility", "calendar_id", "description", "end_datetime", "send_updates", "transparency",
        "start_datetime", "guestsCanModify", "exclude_organizer", "create_meeting_room", "extended_properties")}),
    TOOL_NOTION: ("notion", {"icon": {"type": "string"}, "cover": {"type": "string"},
                             "title": {"type": "string", "required": True}, "markdown": {"type": "string"},
                             "parent_id": {"type": "string", "required": True}}),
    TOOL_GMAIL: ("gmail", {k: {"type": "string"} for k in (
        "cc", "bcc", "body", "is_html", "subject", "user_id", "timezone", "thread_id", "attachment",
        "recipient_email", "extra_recipients", "include_signature")}),
}


def _catalog_with(monkeypatch, bodies):
    monkeypatch.setattr(config, "EXTERNAL_TOOLS_MODE", "composio")
    monkeypatch.setattr(config, "COMPOSIO_AUTH_CONFIGS", {"googlecalendar": "ac_1", "notion": "ac_2", "gmail": "ac_3"})
    monkeypatch.setattr(config, "COMPOSIO_TOOLKIT_VERSIONS", {})
    action_plan_service.clear_catalog_cache()

    def handler(request):
        slug = request.url.path.rsplit("/", 1)[1]
        return httpx.Response(200, json=bodies[slug])

    try:
        return action_plan_service.resolve_catalog(_http(handler))
    finally:
        action_plan_service.clear_catalog_cache()


def test_documented_flat_schemas_resolve_every_catalog_tool(monkeypatch):
    bodies = {s: _tool_body(s, tk, p) for s, (tk, p) in DOC_FLAT.items()}
    assert _catalog_with(monkeypatch, bodies) == {s: "20251201_00" for s in DOC_FLAT}


def test_json_schema_shape_is_also_accepted():
    names, required = parse_input_parameters(
        {"type": "object", "properties": {"title": {}, "parent_id": {}}, "required": ["title"]})
    assert names == {"title", "parent_id"} and required == {"title"}


@pytest.mark.parametrize("mutate", [
    lambda b: b["input_parameters"].pop("parent_id"),                       # argument we send is missing
    lambda b: b["input_parameters"].update({"database_id": {"required": True}}),  # required, never sent
    lambda b: b.update({"is_deprecated": True}),
    lambda b: b.update({"tags": ["destructiveHint"]}),
    lambda b: b.update({"toolkit": {"slug": "gmail"}}),
    lambda b: b.update({"available_versions": ["20250101_00"]}),             # version not offered
    lambda b: b.update({"input_parameters": ["title"]}),                       # not a map
    lambda b: b.update({"input_parameters": {"title": "string"}}),             # entries must be schemas
    lambda b: b.update({"slug": "NOTION_DELETE_BLOCK"}),
])
def test_schema_validation_fails_closed(monkeypatch, mutate):
    bodies = {s: _tool_body(s, tk, dict(p)) for s, (tk, p) in DOC_FLAT.items()}
    mutate(bodies[TOOL_NOTION])
    assert TOOL_NOTION not in _catalog_with(monkeypatch, bodies)


def test_pinned_version_must_match(monkeypatch):
    bodies = {s: _tool_body(s, tk, p) for s, (tk, p) in DOC_FLAT.items()}
    monkeypatch.setattr(config, "COMPOSIO_TOOLKIT_VERSIONS", {"notion": "20260101_00"})
    monkeypatch.setattr(config, "EXTERNAL_TOOLS_MODE", "composio")
    monkeypatch.setattr(config, "COMPOSIO_AUTH_CONFIGS", {"notion": "ac_2"})
    action_plan_service.clear_catalog_cache()
    seen = {}

    def handler(request):
        seen["version"] = request.url.params.get("version")
        return httpx.Response(200, json=bodies[TOOL_NOTION])

    assert action_plan_service.resolve_catalog(_http(handler)) == {}
    assert seen["version"] == "20260101_00"
    action_plan_service.clear_catalog_cache()


# ================================================ 5. stale settlement
def test_settle_after_success_never_downgrades(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    execute(c, view)
    (row,) = rows(eng)
    assert row.status == "succeeded"
    with Session(eng) as s:
        ws = row.workspace_id
        svc = ToolExecutionService(s, ws, transport=fake)
        svc._settle(row.id, "unknown", "late duplicate settlement")
    assert rows(eng)[0].status == "succeeded"


def test_only_overdue_rows_are_settled(env, monkeypatch):
    make_client, eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    capture_jobs(monkeypatch)
    execute(c, view)
    with Session(eng) as s:
        s.execute(update(models.ToolExecution).values(status="executing", dispatched_at=datetime.now(timezone.utc)))
        s.commit()
    executions(c, view)  # triggers the sweep
    assert rows(eng)[0].status == "executing"  # not overdue yet


# ================================================ 6. receipt correlation
def test_calendar_receipt_requires_our_marker():
    key = "k" * 64
    ok = {"response_data": {"id": "evt", "extendedProperties": {"private": {"sgDeliveryKey": key}}}}
    assert extract_receipt(TOOL_CALENDAR, ok, key) == ("evt", None, True)
    for bad in ({"response_data": {"id": "evt"}},
                {"response_data": {"id": "evt", "extendedProperties": {"private": {"sgDeliveryKey": "x"}}}},
                {"response_data": {"extendedProperties": {"private": {"sgDeliveryKey": key}}}}):
        with pytest.raises(ReceiptError):
            extract_receipt(TOOL_CALENDAR, bad, key)


def test_notion_and_gmail_receipts_are_unverified(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "email")
    approve(c, view)
    execute(c, view)
    e = executions(c, view)[0]
    assert e["status"] == "succeeded" and e["receipt"]["verified"] is False
    assert "could not be matched" in e["detail"]
    assert extract_receipt(TOOL_NOTION, {"response_data": {"id": "p1"}}, "k")[2] is False
    assert extract_receipt(TOOL_GMAIL, {"response_data": {"id": "d1"}}, "k")[2] is False


def test_calendar_success_is_verified(env):
    make_client, _eng, planner, fake = env
    c = make_client()
    sid, view = planned(c, planner, "event")
    approve(c, view)
    execute(c, view)
    assert executions(c, view)[0]["receipt"]["verified"] is True


# ================================================ 7. hosted connection identity
@pytest.fixture()
def hosted(env, monkeypatch):
    make_client, eng, planner, fake = env
    monkeypatch.setattr(config, "COMPOSIO_CALLBACK_URL", "http://localhost:5173/?view=world")
    links: list[str] = []
    original = FakeToolTransport.create_link

    def hosted_link(**kw):
        links.append(kw["callback_url"])
        res = original(fake, **kw)
        return LinkResult(res.connected_account_id, "https://connect.composio.dev/link/lk_1")

    monkeypatch.setattr(fake, "create_link", hosted_link)

    def token(i=-1):
        return parse_qs(urlsplit(links[i]).query)["sg_attempt"][0]

    return make_client, eng, fake, links, token


def callback(c, attempt, account=None):
    body = {"attempt": attempt, **({"connectedAccountId": account} if account else {}), "status": "success"}
    return c.post("/api/integrations/callback", headers=HDRS, json=body)


def test_callback_url_carries_a_single_use_attempt_and_completes_only_for_its_workspace(hosted):
    make_client, eng, fake, links, token = hosted
    victim, other = make_client(), make_client()
    r = victim.post("/api/integrations/notion/connect", headers=HDRS).json()
    assert r["connection"]["status"] == "pending" and r["redirectUrl"].startswith("https://")
    assert urlsplit(links[0]).query.startswith("view=world&sg_attempt=")  # existing params preserved
    with Session(eng) as s:
        stored = s.scalars(select(models.ToolConnection)).one()
        assert stored.attempt_token_sha256 != token() and len(stored.attempt_token_sha256) == 64  # hash only
    assert callback(other, token()).status_code == 400  # wrong workspace
    assert victim.post("/api/integrations/notion/refresh", headers=HDRS).json()["connection"]["status"] == "pending"
    assert callback(victim, token(), account="fake_ca_999").status_code == 400  # account mismatch
    ok = callback(victim, token(), account="fake_ca_1")
    assert ok.status_code == 200 and ok.json()["connection"]["status"] == "active"
    assert callback(victim, token()).status_code == 400  # single use


def test_expired_attempt_cannot_complete_and_refresh_marks_it_failed(hosted):
    make_client, eng, fake, links, token = hosted
    c = make_client()
    c.post("/api/integrations/gmail/connect", headers=HDRS)
    with Session(eng) as s:
        s.execute(update(models.ToolConnection).values(
            attempt_expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
        s.commit()
    assert callback(c, token()).status_code == 400
    assert c.post("/api/integrations/gmail/refresh", headers=HDRS).json()["connection"]["status"] == "failed"


def test_provider_owner_mismatch_at_completion_fails_and_burns_the_attempt(hosted):
    make_client, eng, fake, links, token = hosted
    c = make_client()
    c.post("/api/integrations/notion/connect", headers=HDRS)
    fake.reassign("fake_ca_1", "sg_attacker")
    r = callback(c, token())
    assert r.status_code == 200 and r.json()["connection"]["status"] == "failed"
    assert callback(c, token()).status_code == 400


def test_public_hosted_connect_is_off_in_production(env, monkeypatch):
    make_client, _eng, _planner, fake = env
    c = make_client()
    monkeypatch.setattr(config, "EXTERNAL_TOOLS_MODE", "composio")
    monkeypatch.setattr(config, "COMPOSIO_AUTH_CONFIGS", {"notion": "ac_2"})
    monkeypatch.setattr(config, "COMPOSIO_CALLBACK_URL", "https://app.example/?view=world")
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    monkeypatch.setattr(config, "COMPOSIO_PUBLIC_CONNECT", False)
    fake.mode = "composio"
    r = c.post("/api/integrations/notion/connect", headers=HDRS)
    assert r.json()["error"]["code"] == "public_connect_disabled" and "create_link" not in fake.calls


def test_composio_connect_needs_a_callback_url(env, monkeypatch):
    make_client, _eng, _planner, fake = env
    c = make_client()
    monkeypatch.setattr(config, "EXTERNAL_TOOLS_MODE", "composio")
    monkeypatch.setattr(config, "COMPOSIO_AUTH_CONFIGS", {"notion": "ac_2"})
    monkeypatch.setattr(config, "COMPOSIO_CALLBACK_URL", None)
    fake.mode = "composio"
    assert c.post("/api/integrations/notion/connect", headers=HDRS).json()["error"]["code"] == "toolkit_not_configured"


# ================================================ PostgreSQL compatibility (compiled, no server)
def test_partial_unique_indexes_compile_for_postgresql():
    ddl = {ix.name: str(CreateIndex(ix).compile(dialect=postgresql.dialect()))
           for ix in models.ToolExecution.__table__.indexes}
    assert "WHERE status IN ('reserved', 'executing', 'unknown', 'rejected')" in ddl["uq_tool_execution_open_scope"]
    assert "UNIQUE INDEX" in ddl["uq_tool_execution_delivery"]
    assert "'succeeded'" in ddl["uq_tool_execution_delivery"]


def test_conditional_transition_compiles_for_postgresql():
    stmt = (update(models.ToolExecution)
            .where(models.ToolExecution.id == 1, models.ToolExecution.status == "reserved")
            .values(status="executing"))
    sql = str(stmt.compile(dialect=postgresql.dialect()))
    assert "WHERE tool_execution.id = %(id_1)s" in sql and "AND tool_execution.status = %(status_1)s" in sql
