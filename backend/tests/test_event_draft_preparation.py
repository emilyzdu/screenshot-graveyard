"""Add to Calendar: persisted calendar event DRAFT preparation (Batch 4B).

Real HTTP path via TestClient (BackgroundTasks run synchronously after the
response), temp SQLite + private storage, synthetic images, and the
deterministic FakeAIAdapter wrapped to count calls. Never a real provider and
never an external calendar. Fixtures and helpers are shared with the Batch 4A
preparation tests so both actions are exercised under the same conditions.
"""

from __future__ import annotations

import socket
from threading import Barrier, Thread

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app import config
import app.routers.preparations as prep_router
from app.ai.adapter import AIAdapterError
from app.ai.fake_adapter import FakeAIAdapter, FakeAIAdapterMode
from app.ai.openai_vision_adapter import OpenAIVisionAdapter
from app.db import models
from app.db.base import Base
from app.db.repository import WorkspaceRepository
from app.services.consent_service import ConsentService
from app.services.operation_service import OperationServiceUnavailableError
from app.services.preparation_service import PreparationService, idempotency_key
from tests.test_preparations_router import (  # noqa: F401  (pytest fixtures)
    HDRS,
    _archive_on_second_connection,
    _hook_lock,
    _workspace_of,
    counts,
    env,
    file_env,
    upload,
)

CALENDAR = {"action": "add_calendar"}
NOTES = {"action": "make_notes"}
UNKNOWN = ["start_date", "start_time", "end_date", "end_time", "all_day", "time_zone", "location"]


def prepare(c, sid, body=CALENDAR, headers=HDRS):
    return c.post(f"/api/screenshots/{sid}/preparations", headers=headers, json=body)


def kinds(eng) -> dict[str, list[str]]:
    with Session(eng) as s:
        return {
            "operations": sorted(o.kind for o in s.scalars(select(models.Operation))),
            "artifacts": sorted(a.kind for a in s.scalars(select(models.Artifact))),
        }


@pytest.fixture()
def held_event_job(monkeypatch):
    """Hold the event-draft background job so the operation stays pending."""
    held: list[tuple] = []
    real = prep_router._run_event_draft_job
    monkeypatch.setattr(prep_router, "_run_event_draft_job", lambda *a: held.append(a))
    return held, real


# ---------------------------------------------------------------- happy path
def test_prepare_persists_a_simulated_event_draft_and_reopens(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    r = prepare(c, sid)
    assert r.status_code == 202
    body = r.json()
    assert body["action"] == "add_calendar" and body["kind"] == "event_draft"
    assert body["status"] == "pending" and body["reused"] is False and body["provider"] == "fake"
    assert adapter.event_calls == 1 and adapter.calls == 0
    op = c.get(f"/api/operations/{body['operationId']}").json()
    # Everything but a simulated title is missing, so the draft is honestly "uncertain".
    assert op["status"] == "uncertain" and isinstance(op["artifactId"], int)
    lj = c.get(f"/api/screenshots/{sid}/preparations/add_calendar").json()
    assert lj["operationId"] == body["operationId"] and lj["artifactId"] == op["artifactId"]
    assert lj["status"] == "uncertain" and lj["provider"] == "fake"
    draft = c.get(f"/api/event-drafts/{op['artifactId']}")
    assert draft.status_code == 200
    dj = draft.json()
    assert dj["sourceScreenshotIds"] == [sid] and dj["origin"] == "ai_generate" and dj["versionNumber"] == 1
    content = dj["content"]
    assert content["title"] == "Simulated event draft (Fake AI)" and content["uncertain_fields"] == ["title"]
    assert content["missing_fields"] == UNKNOWN
    for f in UNKNOWN:
        assert content[f] is None  # nothing invented: no date, time, zone or location
    assert "did not read your screenshot" in content["description"]
    assert content["references"] == [sid]
    versions = c.get(f"/api/event-drafts/{op['artifactId']}/versions").json()["versions"]
    assert [(v["versionNumber"], v["origin"], v["isCurrent"]) for v in versions] == [(1, "ai_generate", True)]
    with Session(eng) as s:
        assert s.get(models.Operation, body["operationId"]).idempotency_key == idempotency_key(
            sid, "add_calendar", "fake"
        )
    assert kinds(eng) == {"operations": ["event_draft"], "artifacts": ["event_draft"]}
    assert counts(eng) == {"operations": 1, "artifacts": 1, "versions": 1, "sources": 1}


def test_event_draft_reopens_after_a_fresh_app_instance_without_a_new_operation(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    artifact_id = c.get(f"/api/operations/{prepare(c, sid).json()['operationId']}").json()["artifactId"]
    reloaded = make_client()
    reloaded.cookies = c.cookies  # same workspace, new app (page reload / server restart)
    for _ in range(2):
        lj = reloaded.get(f"/api/screenshots/{sid}/preparations/add_calendar").json()
        assert lj["artifactId"] == artifact_id
        assert reloaded.get(f"/api/event-drafts/{artifact_id}").json()["artifactId"] == artifact_id
    assert counts(eng)["operations"] == 1 and adapter.event_calls == 1


def test_no_event_preparation_yet_is_404(env):
    make_client, _, _ = env
    c = make_client()
    sid = upload(c)
    r = c.get(f"/api/screenshots/{sid}/preparations/add_calendar")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_preparation"


# ---------------------------------------------------------------- idempotency
def test_repeat_after_success_reuses_the_same_event_draft(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    first = prepare(c, sid).json()
    for _ in range(3):
        again = prepare(c, sid)
        assert again.status_code == 200 and again.json()["reused"] is True
        assert again.json()["operationId"] == first["operationId"]
    assert adapter.event_calls == 1
    assert counts(eng) == {"operations": 1, "artifacts": 1, "versions": 1, "sources": 1}


def test_repeat_while_pending_reuses_the_running_operation(env, held_event_job):
    make_client, eng, adapter = env
    held, real = held_event_job
    c = make_client()
    sid = upload(c)
    first = prepare(c, sid)
    assert first.status_code == 202 and first.json()["status"] == "pending"
    for _ in range(3):
        again = prepare(c, sid)
        assert again.status_code == 200 and again.json()["operationId"] == first.json()["operationId"]
    assert len(held) == 1 and adapter.event_calls == 0 and counts(eng)["operations"] == 1
    real(*held[0])
    assert c.get(f"/api/operations/{first.json()['operationId']}").json()["status"] == "uncertain"
    assert counts(eng) == {"operations": 1, "artifacts": 1, "versions": 1, "sources": 1}


def test_concurrent_event_prepares_create_exactly_one_operation(tmp_path, monkeypatch):
    """Two real SQLite connections race the same Prepare: one creates, the other reuses or is refused."""
    monkeypatch.setattr(config, "AI_PROVIDER", "fake")
    eng = create_engine(
        f"sqlite:///{tmp_path / 'cal.sqlite'}",
        connect_args={"check_same_thread": False, "timeout": 5},
        poolclass=NullPool,
    )
    Base.metadata.create_all(eng)
    with Session(eng) as s:
        ws = models.Workspace(token_hash="c" * 64)
        s.add(ws)
        s.flush()
        blob = models.ContentBlob(workspace_id=ws.id, sha256="1" * 64, byte_size=1, mime_type="image/png", storage_path="x")
        s.add(blob)
        s.flush()
        shot = models.Screenshot(workspace_id=ws.id, content_blob_id=blob.id, original_filename="s.png")
        s.add(shot)
        s.flush()
        s.add(models.ConsentRecord(workspace_id=ws.id, screenshot_id=shot.id, granted=True))
        s.commit()
        ws_id, sid = ws.id, shot.id
    barrier = Barrier(3)
    results: list[tuple[str, int | None]] = []

    def worker():
        with Session(eng) as session:
            barrier.wait()
            try:
                p = PreparationService(session, ws_id).request(sid, "add_calendar")
                results.append(("reused" if p.reused else "created", p.operation.operation_id))
            except OperationServiceUnavailableError:
                results.append(("unavailable", None))  # SQLite lock contention; nothing written

    threads = [Thread(target=worker) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)
    assert not any(t.is_alive() for t in threads)
    assert [r[0] for r in results].count("created") == 1
    created = next(i for k, i in results if k == "created")
    assert all(i == created for k, i in results if k == "reused")
    with Session(eng) as s:
        ops = list(s.scalars(select(models.Operation)))
        assert [(o.kind, o.idempotency_key) for o in ops] == [
            ("event_draft", idempotency_key(sid, "add_calendar", "fake"))
        ]


# ---------------------------------------------------------------- two actions, two drafts
def test_make_notes_and_calendar_drafts_are_separate_artifacts(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    note_op = prepare(c, sid, NOTES).json()["operationId"]
    event_op = prepare(c, sid).json()["operationId"]
    assert note_op != event_op
    note_id = c.get(f"/api/operations/{note_op}").json()["artifactId"]
    event_id = c.get(f"/api/operations/{event_op}").json()["artifactId"]
    assert note_id != event_id
    assert c.get(f"/api/screenshots/{sid}/preparations/make_notes").json()["artifactId"] == note_id
    assert c.get(f"/api/screenshots/{sid}/preparations/add_calendar").json()["artifactId"] == event_id
    # Each read route only serves its own kind.
    assert c.get(f"/api/study-notes/{event_id}").status_code == 404
    assert c.get(f"/api/event-drafts/{note_id}").status_code == 404
    assert c.get(f"/api/event-drafts/{note_id}/versions").status_code == 404
    assert [n["artifactId"] for n in c.get("/api/study-notes").json()["notes"]] == [note_id]
    # Repeating either action reuses its own operation only.
    assert prepare(c, sid, NOTES).json()["operationId"] == note_op
    assert prepare(c, sid).json()["operationId"] == event_op
    assert adapter.calls == 1 and adapter.event_calls == 1
    assert kinds(eng) == {"operations": ["event_draft", "study_note"], "artifacts": ["event_draft", "study_note"]}


# ---------------------------------------------------------------- failure and retry
@pytest.mark.parametrize("mode, detail", [
    (FakeAIAdapterMode.TIMEOUT, "AI analysis failed"),
    (FakeAIAdapterMode.INVALID, "AI output failed validation"),
])
def test_failed_event_draft_persists_nothing_then_retry_creates_one(env, mode, detail):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    adapter.mode = mode
    failed = prepare(c, sid).json()
    op = c.get(f"/api/operations/{failed['operationId']}").json()
    assert op["status"] == "failed" and op["errorDetail"] == detail and op.get("artifactId") is None
    assert counts(eng)["artifacts"] == 0
    adapter.mode = FakeAIAdapterMode.NORMAL
    retry = prepare(c, sid)
    assert retry.status_code == 202 and retry.json()["operationId"] != failed["operationId"]
    assert c.get(f"/api/operations/{retry.json()['operationId']}").json()["status"] == "uncertain"
    assert prepare(c, sid).json()["reused"] is True
    assert counts(eng) == {"operations": 2, "artifacts": 1, "versions": 1, "sources": 1}


def test_adapter_references_must_be_exactly_the_screenshot(env, monkeypatch):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    monkeypatch.setattr(
        type(adapter), "event_draft",
        lambda self, images: FakeAIAdapter().event_draft([(sid + 100, b"", "image/png")]),
    )
    op = c.get(f"/api/operations/{prepare(c, sid).json()['operationId']}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "AI output references invalid"
    assert counts(eng)["artifacts"] == 0


def test_adapter_invented_dates_without_a_zone_are_rejected(env, monkeypatch):
    """An adapter that supplies a time but no time zone fails validation; nothing is stored."""
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    monkeypatch.setattr(type(adapter), "event_draft", lambda self, images: {
        "title": "Meeting", "start_date": "2026-12-01", "start_time": "15:00",
        "end_date": "2026-12-01", "end_time": "16:00", "all_day": False,
        "time_zone": None, "missing_fields": ["time_zone"], "references": [sid],
    })
    op = c.get(f"/api/operations/{prepare(c, sid).json()['operationId']}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "AI output failed validation"
    assert counts(eng)["artifacts"] == 0


def test_a_fully_known_valid_draft_is_successful_not_uncertain(env, monkeypatch):
    make_client, _, adapter = env
    c = make_client()
    sid = upload(c)
    monkeypatch.setattr(type(adapter), "event_draft", lambda self, images: {
        "title": "Seminar", "start_date": "2026-12-01", "start_time": "15:00",
        "end_date": "2026-12-01", "end_time": "16:00", "all_day": False,
        "time_zone": "Europe/London", "references": [sid],
    })
    op = c.get(f"/api/operations/{prepare(c, sid).json()['operationId']}").json()
    assert op["status"] == "successful"
    content = c.get(f"/api/event-drafts/{op['artifactId']}").json()["content"]
    assert (content["start_date"], content["start_time"], content["time_zone"]) == ("2026-12-01", "15:00", "Europe/London")


# ---------------------------------------------------------------- access and eligibility
@pytest.mark.parametrize("sid", [999_999, 0, -1])
def test_invalid_screenshot_id_is_404(env, sid):
    make_client, eng, adapter = env
    c = make_client()
    upload(c)
    assert prepare(c, sid).status_code == 404
    assert c.get(f"/api/screenshots/{sid}/preparations/add_calendar").status_code == 404
    assert counts(eng)["operations"] == 0 and adapter.event_calls == 0


@pytest.mark.parametrize("aid", [999_999, 0, -1])
def test_invalid_event_draft_id_is_404(env, aid):
    make_client, _, _ = env
    c = make_client()
    assert c.get(f"/api/event-drafts/{aid}").status_code == 404
    assert c.get(f"/api/event-drafts/{aid}/versions").status_code == 404


def test_version_of_another_draft_is_404(env):
    make_client, _, _ = env
    c = make_client()
    a, b = upload(c, (1, 2, 3)), upload(c, (4, 5, 6))
    aid = c.get(f"/api/operations/{prepare(c, a).json()['operationId']}").json()["artifactId"]
    bid = c.get(f"/api/operations/{prepare(c, b).json()['operationId']}").json()["artifactId"]
    bver = c.get(f"/api/event-drafts/{bid}").json()["versionId"]
    assert c.get(f"/api/event-drafts/{aid}", params={"versionId": bver}).status_code == 404


def test_cross_workspace_requests_are_indistinguishable_404s(env):
    make_client, eng, adapter = env
    owner = make_client()
    sid = upload(owner)
    aid = owner.get(f"/api/operations/{prepare(owner, sid).json()['operationId']}").json()["artifactId"]
    other = make_client()
    assert other.cookies.get("sg_workspace") != owner.cookies.get("sg_workspace")
    assert prepare(other, sid).status_code == 404
    assert other.get(f"/api/screenshots/{sid}/preparations/add_calendar").status_code == 404
    assert other.get(f"/api/event-drafts/{aid}").status_code == 404
    assert other.get(f"/api/event-drafts/{aid}/versions").status_code == 404
    assert counts(eng)["operations"] == 1 and adapter.event_calls == 1


def test_event_draft_reads_require_a_workspace(env):
    make_client, _, _ = env
    owner = make_client()
    sid = upload(owner)
    aid = owner.get(f"/api/operations/{prepare(owner, sid).json()['operationId']}").json()["artifactId"]
    anonymous = TestClient(owner.app)
    assert anonymous.get(f"/api/event-drafts/{aid}").status_code == 401


def test_archived_screenshot_cannot_be_prepared(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200
    r = prepare(c, sid)
    assert r.status_code == 409 and r.json()["error"]["code"] == "screenshot_archived"
    assert counts(eng)["operations"] == 0 and adapter.event_calls == 0


def test_archive_committed_before_acceptance_rejects_the_calendar_prepare(file_env, held_event_job, monkeypatch):
    """Batch 4A race fix applies to Add to Calendar: archive on a 2nd connection wins."""
    c, eng, adapter = file_env
    held, _ = held_event_job
    sid = upload(c)
    ws_id = _workspace_of(eng, sid)
    _hook_lock(monkeypatch, before=lambda: _archive_on_second_connection(eng, ws_id, sid))
    r = prepare(c, sid)
    assert r.status_code == 409 and r.json()["error"]["code"] == "screenshot_archived"
    assert counts(eng)["operations"] == 0 and held == [] and adapter.event_calls == 0


def test_calendar_prepare_holding_the_lock_serializes_a_concurrent_archive(file_env, held_event_job, monkeypatch):
    c, eng, adapter = file_env
    held, real = held_event_job
    sid = upload(c)
    ws_id = _workspace_of(eng, sid)
    seen: dict[str, object] = {}

    def archive_while_locked():
        t = Thread(target=lambda: _archive_on_second_connection(eng, ws_id, sid))
        t.start()
        t.join(timeout=0.5)
        seen["blocked"] = t.is_alive()
        seen["thread"] = t

    _hook_lock(monkeypatch, after=archive_while_locked)
    r = prepare(c, sid)
    assert r.status_code == 202
    seen["thread"].join(timeout=10)
    assert seen["blocked"] is True and not seen["thread"].is_alive()
    real(*held[0])
    op = c.get(f"/api/operations/{r.json()['operationId']}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "Screenshot archived"
    assert adapter.event_calls == 0 and counts(eng)["artifacts"] == 0


def test_screenshot_archived_after_acceptance_fails_without_processing(env, held_event_job):
    make_client, eng, adapter = env
    held, real = held_event_job
    c = make_client()
    sid = upload(c)
    op_id = prepare(c, sid).json()["operationId"]
    c.post(f"/api/screenshots/{sid}/archive", headers=HDRS)
    real(*held[0])
    op = c.get(f"/api/operations/{op_id}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "Screenshot archived"
    assert adapter.event_calls == 0 and counts(eng)["artifacts"] == 0


def test_existing_event_draft_stays_readable_after_archive(env):
    make_client, _, _ = env
    c = make_client()
    sid = upload(c)
    aid = c.get(f"/api/operations/{prepare(c, sid).json()['operationId']}").json()["artifactId"]
    c.post(f"/api/screenshots/{sid}/archive", headers=HDRS)
    assert c.get(f"/api/screenshots/{sid}/preparations/add_calendar").json()["artifactId"] == aid
    assert c.get(f"/api/event-drafts/{aid}").status_code == 200
    assert prepare(c, sid).status_code == 409


# ---------------------------------------------------------------- consent
def test_missing_consent_is_403_and_creates_nothing(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c, consent=False)
    r = prepare(c, sid)
    assert r.status_code == 403 and r.json()["error"]["code"] == "consent_required"
    assert counts(eng)["operations"] == 0 and adapter.event_calls == 0


def test_consent_withdrawn_after_acceptance_fails_without_processing(env, held_event_job):
    make_client, eng, adapter = env
    held, real = held_event_job
    c = make_client()
    sid = upload(c)
    op_id = prepare(c, sid).json()["operationId"]
    c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json={"granted": False})
    real(*held[0])
    op = c.get(f"/api/operations/{op_id}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "AI processing consent required"
    assert adapter.event_calls == 0 and counts(eng)["artifacts"] == 0


def test_consent_withdrawn_while_reading_the_original_stops_before_the_adapter(env, monkeypatch):
    """The second consent check sits between the byte read and the adapter call."""
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    ws_id = _workspace_of(eng, sid)
    from app.services import vault_service

    real_read = vault_service.VaultService.read_original

    def read_then_revoke(self, screenshot_id):
        original = real_read(self, screenshot_id)
        with Session(eng) as other:
            ConsentService(other, ws_id).record_consent(screenshot_id, False)
        return original

    monkeypatch.setattr(vault_service.VaultService, "read_original", read_then_revoke)
    op = c.get(f"/api/operations/{prepare(c, sid).json()['operationId']}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "AI processing consent required"
    assert adapter.event_calls == 0 and counts(eng)["artifacts"] == 0


# ---------------------------------------------------------------- quota
def test_event_drafts_count_toward_the_ai_quota(env, monkeypatch):
    make_client, eng, adapter = env
    c = make_client()
    a, b = upload(c, (1, 1, 1)), upload(c, (2, 2, 2))
    ws_id = _workspace_of(eng, a)
    assert prepare(c, a).status_code == 202
    with Session(eng) as s:
        assert WorkspaceRepository(s, ws_id).count_ai_operations() == 1
    monkeypatch.setattr(config, "MAX_AI_CALLS_PER_WORKSPACE", 1)
    r = prepare(c, b)
    assert r.status_code == 429 and r.json()["error"]["code"] == "quota_exceeded"
    assert prepare(c, b, NOTES).status_code == 429  # one shared AI quota
    assert prepare(c, a).status_code == 200  # reusing an existing draft consumes nothing
    assert counts(eng)["operations"] == 1 and adapter.event_calls == 1


# ---------------------------------------------------------------- provider and network
def test_real_provider_fails_closed_at_the_route(env, monkeypatch):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    monkeypatch.setattr(config, "AI_PROVIDER", "openai")
    r = prepare(c, sid)
    assert r.status_code == 409 and r.json()["error"]["code"] == "provider_not_permitted"
    assert counts(eng)["operations"] == 0 and adapter.event_calls == 0


def test_real_provider_fails_closed_in_the_worker(env, held_event_job, monkeypatch):
    make_client, eng, adapter = env
    held, real = held_event_job
    c = make_client()
    sid = upload(c)
    op_id = prepare(c, sid).json()["operationId"]
    monkeypatch.setattr(config, "AI_PROVIDER", "openai")
    real(*held[0])
    op = c.get(f"/api/operations/{op_id}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "AI processing unavailable"
    assert adapter.event_calls == 0 and counts(eng)["artifacts"] == 0


def test_the_openai_adapter_refuses_event_drafts_without_a_request():
    class _NoCalls:
        class responses:  # noqa: N801  (mirrors the SDK attribute name)
            @staticmethod
            def parse(**kwargs):
                raise AssertionError("no provider request may be built")

    adapter = OpenAIVisionAdapter(client=_NoCalls(), model="m")
    with pytest.raises(AIAdapterError, match="not supported"):
        adapter.event_draft([(1, b"\x89PNG", "image/png")])


def test_no_network_connection_is_made_during_calendar_preparation(env, monkeypatch):
    """No external calendar or provider write: any outbound socket connect fails the test."""
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    attempts: list[object] = []

    def refuse(self, address, *a, **kw):
        attempts.append(address)
        raise AssertionError(f"unexpected network connection to {address}")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    op_id = prepare(c, sid).json()["operationId"]
    assert c.get(f"/api/operations/{op_id}").json()["status"] == "uncertain"
    assert attempts == [] and adapter.event_calls == 1


def test_no_calendar_delivery_route_exists(env):
    make_client, _, _ = env
    c = make_client()
    paths = c.get("/openapi.json").json()["paths"]
    assert {p: sorted(paths[p]) for p in paths if "event-draft" in p} == {
        "/api/event-drafts/{artifact_id}": ["get"],
        "/api/event-drafts/{artifact_id}/versions": ["get"],
        "/api/event-drafts/{artifact_id}/edits": ["post"],  # Batch 5A: internal manual edits only
    }
    assert not [p for p in paths if "calendar" in p.lower() or "oauth" in p.lower()]


# ---------------------------------------------------------------- B3: stored references must agree
# Disposable SQLite rows are corrupted directly (raw SQL, bypassing the ORM's
# append-only guard) to model inconsistent stored data.
from sqlalchemy import text  # noqa: E402


def _two_workspaces_with_drafts(env):
    make_client, eng, _ = env
    a = make_client()
    sid_a = upload(a, (1, 2, 3))
    art_a = a.get(f"/api/operations/{prepare(a, sid_a).json()['operationId']}").json()["artifactId"]
    b = make_client()
    sid_b = upload(b, (9, 8, 7))
    b.get(f"/api/operations/{prepare(b, sid_b).json()['operationId']}").json()
    return a, eng, sid_a, art_a, sid_b


def _rewrite_references(eng, artifact_id: int, refs: list[int]):
    import json as _json

    with eng.begin() as conn:
        row = conn.execute(
            text("select id, content_json from artifact_version where artifact_id = :a"), {"a": artifact_id}
        ).one()
        content = _json.loads(row.content_json)
        content["references"] = refs
        conn.execute(
            text("update artifact_version set content_json = :c where id = :i"),
            {"c": _json.dumps(content), "i": row.id},
        )
        return row.id


def _assert_generic_503(resp, *forbidden: int):
    assert resp.status_code == 503
    assert resp.json() == {"error": {"code": "service_unavailable", "message": "Service temporarily unavailable"}}
    for value in forbidden:
        assert str(value) not in resp.text


def test_payload_referencing_a_foreign_screenshot_is_a_generic_503(env):
    a, eng, sid_a, art_a, sid_b = _two_workspaces_with_drafts(env)
    version_id = _rewrite_references(eng, art_a, [sid_b])
    _assert_generic_503(a.get(f"/api/event-drafts/{art_a}"), sid_b)
    _assert_generic_503(a.get(f"/api/event-drafts/{art_a}", params={"versionId": version_id}), sid_b)


def test_payload_with_extra_or_duplicate_references_is_a_generic_503(env):
    a, eng, sid_a, art_a, sid_b = _two_workspaces_with_drafts(env)
    _rewrite_references(eng, art_a, [sid_a, sid_b])
    _assert_generic_503(a.get(f"/api/event-drafts/{art_a}"), sid_b)


def test_payload_referencing_another_own_screenshot_is_a_generic_503(env):
    a, eng, sid_a, art_a, _ = _two_workspaces_with_drafts(env)
    other_own = upload(a, (5, 5, 5))
    _rewrite_references(eng, art_a, [other_own])
    _assert_generic_503(a.get(f"/api/event-drafts/{art_a}"))


def test_missing_source_reference_row_is_a_generic_503(env):
    a, eng, sid_a, art_a, _ = _two_workspaces_with_drafts(env)
    with eng.begin() as conn:
        conn.execute(text("delete from source_reference where artifact_id = :a"), {"a": art_a})
    _assert_generic_503(a.get(f"/api/event-drafts/{art_a}"))


def test_extra_source_reference_row_breaks_the_single_screenshot_contract(env):
    a, eng, sid_a, art_a, _ = _two_workspaces_with_drafts(env)
    other_own = upload(a, (6, 6, 6))
    ws = _workspace_of(eng, sid_a)
    with eng.begin() as conn:
        conn.execute(
            text("insert into source_reference (workspace_id, artifact_id, screenshot_id) values (:w, :a, :s)"),
            {"w": ws, "a": art_a, "s": other_own},
        )
    _assert_generic_503(a.get(f"/api/event-drafts/{art_a}"))


def test_valid_drafts_and_versions_still_read_normally(env):
    a, eng, sid_a, art_a, _ = _two_workspaces_with_drafts(env)
    current = a.get(f"/api/event-drafts/{art_a}")
    assert current.status_code == 200 and current.json()["sourceScreenshotIds"] == [sid_a]
    assert current.json()["content"]["references"] == [sid_a]
    again = a.get(f"/api/event-drafts/{art_a}", params={"versionId": current.json()["versionId"]})
    assert again.status_code == 200 and again.json() == current.json()


def test_source_row_and_payload_both_pointing_at_a_foreign_screenshot_is_a_generic_503(env):
    """Consistent with each other but not owned: the ownership check is what catches it."""
    a, eng, sid_a, art_a, sid_b = _two_workspaces_with_drafts(env)
    with eng.begin() as conn:
        conn.execute(text("update source_reference set screenshot_id = :b where artifact_id = :a"), {"a": art_a, "b": sid_b})
    _rewrite_references(eng, art_a, [sid_b])
    _assert_generic_503(a.get(f"/api/event-drafts/{art_a}"), sid_b)


def test_a_consistent_two_screenshot_draft_still_breaks_the_single_screenshot_contract(env):
    """Rows and payload agree on TWO owned screenshots; Batch 4B drafts have exactly one."""
    a, eng, sid_a, art_a, _ = _two_workspaces_with_drafts(env)
    other_own = upload(a, (7, 7, 7))
    ws = _workspace_of(eng, sid_a)
    with eng.begin() as conn:
        conn.execute(
            text("insert into source_reference (workspace_id, artifact_id, screenshot_id) values (:w, :a, :s)"),
            {"w": ws, "a": art_a, "s": other_own},
        )
    _rewrite_references(eng, art_a, [sid_a, other_own])
    _assert_generic_503(a.get(f"/api/event-drafts/{art_a}"))
