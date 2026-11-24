"""Make Notes draft preparation (Batch 4A).

Real HTTP path via TestClient (BackgroundTasks run synchronously after the
response), temp SQLite + private storage, synthetic images, and the
deterministic FakeAIAdapter wrapped to count calls. Never a real provider.
"""

from __future__ import annotations

import io
import os
import socket
from threading import Barrier, Thread

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool, StaticPool

from app import config
import app.db.session as sess_mod
import app.routers.preparations as prep_router
from app.ai import provider
from app.ai.fake_adapter import FakeAIAdapter, FakeAIAdapterMode
from app.db import models
from app.db.base import Base
from app.main import create_app
from app.ratelimit import TokenBucketRateLimiter
from app.services.consent_service import ConsentRequiredError
from app.services.operation_service import OperationServiceUnavailableError
from app.services.preparation_service import PreparationService, idempotency_key

TRUSTED = config.TRUSTED_ORIGINS[0]
HDRS = {"Origin": TRUSTED, "X-Requested-With": "fetch"}
MAKE_NOTES = {"action": "make_notes"}


def png(color) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (12, 9), color).save(b, format="PNG")
    return b.getvalue()


class CountingFake:
    """The real FakeAIAdapter, counting study_note calls; mode is switchable."""

    def __init__(self):
        self.mode = FakeAIAdapterMode.NORMAL
        self.calls = 0
        self.event_calls = 0

    def classify_and_epitaph(self, image_bytes, mime, **kw):
        return FakeAIAdapter().classify_and_epitaph(image_bytes, mime, **kw)

    def study_note(self, images, **kw):
        self.calls += 1
        return FakeAIAdapter(mode=self.mode).study_note(images, **kw)

    def event_draft(self, images):
        # Batch 4B: counted separately so Make Notes assertions are unaffected.
        self.event_calls += 1
        return FakeAIAdapter(mode=self.mode).event_draft(images)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    factory = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False, class_=Session)
    monkeypatch.setattr(sess_mod, "engine", eng)
    monkeypatch.setattr(sess_mod, "SessionLocal", factory)
    monkeypatch.setattr(config, "COOKIE_SECURE", False)
    monkeypatch.setattr(config, "STORAGE_ROOT", str(tmp_path / "storage"))
    monkeypatch.setattr(config, "AI_PROVIDER", "fake")

    saved = provider.get_ai_adapter()
    adapter = CountingFake()

    def make_client():
        lim = TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0)
        wlim = TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0)
        app = create_app(workspace_session_factory=factory, rate_limiter=lim, workspace_rate_limiter=wlim)
        # create_app() configures the provider adapter: inject the counting fake after it.
        provider.set_ai_adapter(adapter)
        c = TestClient(app)
        c.get("/api/workspace")
        return c
    yield make_client, eng, adapter
    provider.set_ai_adapter(saved)
    for p in (tmp_path / "storage").rglob("*"):
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass


def upload(c, color=(10, 20, 30), consent=True) -> int:
    r = c.post("/api/screenshots", headers=HDRS, files=[("files", ("s.png", png(color), "image/png"))])
    sid = r.json()["results"][0]["screenshotId"]
    if consent:
        assert c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json={"granted": True}).status_code == 200
    return sid


def prepare(c, sid, body=MAKE_NOTES, headers=HDRS):
    return c.post(f"/api/screenshots/{sid}/preparations", headers=headers, json=body)


def counts(eng):
    with Session(eng) as s:
        return {
            "operations": s.scalar(select(func.count()).select_from(models.Operation)),
            "artifacts": s.scalar(select(func.count()).select_from(models.Artifact)),
            "versions": s.scalar(select(func.count()).select_from(models.ArtifactVersion)),
            "sources": s.scalar(select(func.count()).select_from(models.SourceReference)),
        }


@pytest.fixture()
def deferred_job(monkeypatch):
    """Hold the background job so the operation stays pending; run it on demand."""
    held: list[tuple] = []
    real = prep_router._run_make_notes_job
    monkeypatch.setattr(prep_router, "_run_make_notes_job", lambda *a: held.append(a))
    return held, real


# ---------------------------------------------------------------- happy path

def test_prepare_persists_a_simulated_draft_and_reopens(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    r = prepare(c, sid)
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "pending" and body["reused"] is False and body["provider"] == "fake"
    assert body["screenshotId"] == sid and body["action"] == "make_notes" and body["kind"] == "study_note"
    assert adapter.calls == 1
    op = c.get(f"/api/operations/{body['operationId']}").json()
    assert op["status"] == "successful" and isinstance(op["artifactId"], int)

    latest = c.get(f"/api/screenshots/{sid}/preparations/make_notes")
    assert latest.status_code == 200
    lj = latest.json()
    assert lj["operationId"] == body["operationId"] and lj["artifactId"] == op["artifactId"]
    assert lj["status"] == "successful" and lj["provider"] == "fake" and lj["reused"] is False

    draft = c.get(f"/api/study-notes/{op['artifactId']}").json()
    assert draft["sourceScreenshotIds"] == [sid]
    assert draft["origin"] == "ai_generate" and draft["versionNumber"] == 1
    assert draft["content"]["topic"] == "Synthetic study note fixture"  # self-describing simulated content
    with Session(eng) as s:
        row = s.get(models.Operation, body["operationId"])
        assert row.idempotency_key == idempotency_key(sid, "make_notes", "fake")
    assert counts(eng) == {"operations": 1, "artifacts": 1, "versions": 1, "sources": 1}


def test_draft_reopens_after_a_fresh_app_instance(env):
    make_client, _, _ = env
    c = make_client()
    sid = upload(c)
    artifact_id = c.get(f"/api/operations/{prepare(c, sid).json()['operationId']}").json()["artifactId"]
    reloaded = make_client()
    reloaded.cookies = c.cookies  # same workspace, new app (like a page reload / server restart)
    lj = reloaded.get(f"/api/screenshots/{sid}/preparations/make_notes").json()
    assert lj["artifactId"] == artifact_id and lj["status"] == "successful"
    assert reloaded.get(f"/api/study-notes/{artifact_id}").status_code == 200


def test_no_preparation_yet_is_404_and_listing_exposes_the_draft(env):
    make_client, _, _ = env
    c = make_client()
    sid = upload(c)
    none = c.get(f"/api/screenshots/{sid}/preparations/make_notes")
    assert none.status_code == 404 and none.json()["error"]["code"] == "no_preparation"
    artifact_id = c.get(f"/api/operations/{prepare(c, sid).json()['operationId']}").json()["artifactId"]
    assert [n["artifactId"] for n in c.get("/api/study-notes").json()["notes"]] == [artifact_id]


# ---------------------------------------------------------------- idempotency

def test_repeat_after_success_reuses_the_same_draft(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    first = prepare(c, sid).json()
    again = prepare(c, sid)
    assert again.status_code == 200
    aj = again.json()
    assert aj["reused"] is True and aj["operationId"] == first["operationId"]
    assert aj["status"] == "successful" and isinstance(aj["artifactId"], int)
    assert adapter.calls == 1
    assert counts(eng) == {"operations": 1, "artifacts": 1, "versions": 1, "sources": 1}


def test_repeat_while_pending_reuses_the_running_operation(env, deferred_job):
    make_client, eng, adapter = env
    held, real = deferred_job
    c = make_client()
    sid = upload(c)
    first = prepare(c, sid)
    assert first.status_code == 202 and first.json()["status"] == "pending"
    for _ in range(3):
        again = prepare(c, sid)
        assert again.status_code == 200
        assert again.json() | {"reused": False} == first.json()  # identical apart from `reused`
        assert again.json()["reused"] is True
    assert len(held) == 1 and adapter.calls == 0
    assert counts(eng)["operations"] == 1
    real(*held[0])
    assert c.get(f"/api/operations/{first.json()['operationId']}").json()["status"] == "successful"
    assert counts(eng) == {"operations": 1, "artifacts": 1, "versions": 1, "sources": 1}


def test_concurrent_requests_create_exactly_one_operation(tmp_path, monkeypatch):
    """Two connections race the same Prepare: one creates, the other reuses or is refused."""
    monkeypatch.setattr(config, "AI_PROVIDER", "fake")
    eng = create_engine(
        f"sqlite:///{tmp_path / 'prep.sqlite'}",
        connect_args={"check_same_thread": False, "timeout": 5},
        poolclass=NullPool,
    )
    Base.metadata.create_all(eng)
    with Session(eng) as s:
        ws = models.Workspace(token_hash="p" * 64)
        s.add(ws)
        s.flush()
        blob = models.ContentBlob(workspace_id=ws.id, sha256="0" * 64, byte_size=1, mime_type="image/png", storage_path="x")
        s.add(blob)
        s.flush()
        shot = models.Screenshot(workspace_id=ws.id, content_blob_id=blob.id, original_filename="s.png")
        s.add(shot)
        s.flush()
        s.add(models.ConsentRecord(workspace_id=ws.id, screenshot_id=shot.id, granted=True))
        s.commit()
        ws_id, sid = ws.id, shot.id
    barrier = Barrier(2)
    results: list[tuple[str, int | None]] = []

    def worker():
        with Session(eng) as session:
            barrier.wait()
            try:
                p = PreparationService(session, ws_id).request(sid, "make_notes")
                results.append(("reused" if p.reused else "created", p.operation.operation_id))
            except OperationServiceUnavailableError:
                results.append(("unavailable", None))  # SQLite lock contention; nothing written

    threads = [Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=15)
    assert not any(t.is_alive() for t in threads)
    assert [r[0] for r in results].count("created") == 1
    created_id = next(i for k, i in results if k == "created")
    assert all(i == created_id for k, i in results if k == "reused")
    with Session(eng) as s:
        assert s.scalar(select(func.count()).select_from(models.Operation)) == 1


# ---------------------------------------------------------------- failure and retry

@pytest.mark.parametrize("mode", [FakeAIAdapterMode.TIMEOUT, FakeAIAdapterMode.INVALID])
def test_failed_preparation_then_safe_retry_creates_one_draft(env, mode):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    adapter.mode = mode
    failed = prepare(c, sid).json()
    assert c.get(f"/api/operations/{failed['operationId']}").json()["status"] == "failed"
    lj = c.get(f"/api/screenshots/{sid}/preparations/make_notes").json()
    assert lj["status"] == "failed" and lj["artifactId"] is None
    assert counts(eng)["artifacts"] == 0  # a failure persists no draft
    adapter.mode = FakeAIAdapterMode.NORMAL
    retry = prepare(c, sid)
    assert retry.status_code == 202 and retry.json()["reused"] is False
    assert retry.json()["operationId"] != failed["operationId"]
    assert c.get(f"/api/operations/{retry.json()['operationId']}").json()["status"] == "successful"
    assert prepare(c, sid).json()["reused"] is True  # and now it sticks
    assert counts(eng) == {"operations": 2, "artifacts": 1, "versions": 1, "sources": 1}


# ---------------------------------------------------------------- access and eligibility

@pytest.mark.parametrize("sid", [999_999, 0, -1])
def test_invalid_screenshot_id_is_404(env, sid):
    make_client, eng, adapter = env
    c = make_client()
    upload(c)
    assert prepare(c, sid).status_code == 404
    assert c.get(f"/api/screenshots/{sid}/preparations/make_notes").status_code == 404
    assert counts(eng)["operations"] == 0 and adapter.calls == 0


def test_cross_workspace_requests_are_indistinguishable_404s(env):
    make_client, eng, adapter = env
    owner = make_client()
    sid = upload(owner)
    prepare(owner, sid)
    other = make_client()  # a different workspace (its own cookie)
    assert other.cookies.get("sg_workspace") != owner.cookies.get("sg_workspace")
    assert prepare(other, sid).status_code == 404
    assert other.get(f"/api/screenshots/{sid}/preparations/make_notes").status_code == 404
    assert counts(eng)["operations"] == 1 and adapter.calls == 1


def test_archived_screenshot_cannot_be_prepared(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200
    r = prepare(c, sid)
    assert r.status_code == 409 and r.json()["error"]["code"] == "screenshot_archived"
    assert counts(eng)["operations"] == 0 and adapter.calls == 0


def test_screenshot_archived_after_acceptance_fails_without_processing(env, deferred_job):
    make_client, eng, adapter = env
    held, real = deferred_job
    c = make_client()
    sid = upload(c)
    op_id = prepare(c, sid).json()["operationId"]
    c.post(f"/api/screenshots/{sid}/archive", headers=HDRS)
    real(*held[0])
    op = c.get(f"/api/operations/{op_id}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "Screenshot archived"
    assert adapter.calls == 0 and counts(eng)["artifacts"] == 0


def test_existing_draft_stays_readable_after_archive(env):
    make_client, _, _ = env
    c = make_client()
    sid = upload(c)
    prepare(c, sid)
    c.post(f"/api/screenshots/{sid}/archive", headers=HDRS)
    assert c.get(f"/api/screenshots/{sid}/preparations/make_notes").json()["status"] == "successful"


# ---------------------------------------------------------------- consent

def test_missing_consent_is_403_and_creates_nothing(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c, consent=False)
    r = prepare(c, sid)
    assert r.status_code == 403 and r.json()["error"]["code"] == "consent_required"
    assert counts(eng)["operations"] == 0 and adapter.calls == 0


def test_consent_withdrawn_after_acceptance_fails_without_processing(env, deferred_job):
    make_client, eng, adapter = env
    held, real = deferred_job
    c = make_client()
    sid = upload(c)
    op_id = prepare(c, sid).json()["operationId"]
    c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json={"granted": False})
    real(*held[0])
    op = c.get(f"/api/operations/{op_id}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "AI processing consent required"
    assert adapter.calls == 0 and counts(eng)["artifacts"] == 0


def test_consent_withdrawn_after_a_draft_exists_returns_it_without_processing(env):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    first = prepare(c, sid).json()
    c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json={"granted": False})
    again = prepare(c, sid)
    assert again.status_code == 200 and again.json()["operationId"] == first["operationId"]
    assert adapter.calls == 1 and counts(eng)["operations"] == 1


def test_consent_is_checked_inside_the_lock_before_creating(env, monkeypatch):
    make_client, eng, _ = env
    c = make_client()
    sid = upload(c)

    def deny(self, screenshot_id):
        raise ConsentRequiredError("withdrawn just now")

    monkeypatch.setattr("app.services.consent_service.ConsentService.require_consent", deny)
    assert prepare(c, sid).status_code == 403
    assert counts(eng)["operations"] == 0


# ---------------------------------------------------------------- request boundary

@pytest.mark.parametrize(
    "body",
    [
        {"action": "save_memory"},
        {"action": "add_wishlist"},
        {"action": "make_notes", "extra": 1},
        {"action": "add_calendar", "extra": 1},
        {},
        {"action": 1},
    ],
)
def test_only_an_explicit_supported_action_request_is_accepted(env, body):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    assert prepare(c, sid, body=body).status_code == 422
    assert counts(eng)["operations"] == 0 and adapter.calls == 0


def test_unsupported_action_lookup_is_400(env):
    make_client, _, _ = env
    c = make_client()
    sid = upload(c)
    assert c.get(f"/api/screenshots/{sid}/preparations/save_memory").status_code == 400


def test_csrf_header_is_required(env):
    make_client, eng, _ = env
    c = make_client()
    sid = upload(c)
    assert prepare(c, sid, headers={"Origin": TRUSTED}).status_code == 403
    assert prepare(c, sid, headers={"X-Requested-With": "fetch", "Origin": "https://evil.example"}).status_code == 403
    assert counts(eng)["operations"] == 0


def test_real_provider_fails_closed_at_the_route(env, monkeypatch):
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    monkeypatch.setattr(config, "AI_PROVIDER", "openai")
    r = prepare(c, sid)
    assert r.status_code == 409 and r.json()["error"]["code"] == "provider_not_permitted"
    assert counts(eng)["operations"] == 0 and adapter.calls == 0


def test_real_provider_fails_closed_in_the_worker(env, deferred_job, monkeypatch):
    make_client, eng, adapter = env
    held, real = deferred_job
    c = make_client()
    sid = upload(c)
    op_id = prepare(c, sid).json()["operationId"]
    monkeypatch.setattr(config, "AI_PROVIDER", "openai")  # reconfigured after acceptance
    real(*held[0])
    op = c.get(f"/api/operations/{op_id}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "AI processing unavailable"
    assert adapter.calls == 0 and counts(eng)["artifacts"] == 0


def test_no_network_connection_is_made_during_preparation(env, monkeypatch):
    """No external write or provider call: any outbound socket connect fails the test."""
    make_client, eng, adapter = env
    c = make_client()
    sid = upload(c)
    attempts: list[object] = []

    def refuse(self, address, *a, **kw):
        attempts.append(address)
        raise AssertionError(f"unexpected network connection to {address}")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    op_id = prepare(c, sid).json()["operationId"]
    assert c.get(f"/api/operations/{op_id}").json()["status"] == "successful"
    assert attempts == [] and adapter.calls == 1


# ---------------------------------------------------------------- Safe Burial / Prepare race
# Real file-backed SQLite, NullPool: every Session is its own sqlite3 connection, so
# the interleavings below exercise SQLite's actual database write lock (SQLite has no
# row locks; FOR UPDATE is a no-op there).
from app.db.repository import WorkspaceRepository  # noqa: E402
from app.services.vault_service import VaultService  # noqa: E402


@pytest.fixture()
def file_env(tmp_path, monkeypatch):
    eng = create_engine(
        f"sqlite:///{tmp_path / 'race.sqlite'}",
        connect_args={"check_same_thread": False, "timeout": 5},
        poolclass=NullPool,
    )
    Base.metadata.create_all(eng)
    factory = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False, class_=Session)
    monkeypatch.setattr(sess_mod, "engine", eng)
    monkeypatch.setattr(sess_mod, "SessionLocal", factory)
    monkeypatch.setattr(config, "COOKIE_SECURE", False)
    monkeypatch.setattr(config, "STORAGE_ROOT", str(tmp_path / "storage"))
    monkeypatch.setattr(config, "AI_PROVIDER", "fake")
    saved = provider.get_ai_adapter()
    adapter = CountingFake()
    lim = TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0)
    wlim = TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0)
    app = create_app(workspace_session_factory=factory, rate_limiter=lim, workspace_rate_limiter=wlim)
    provider.set_ai_adapter(adapter)
    c = TestClient(app)
    c.get("/api/workspace")
    yield c, eng, adapter
    provider.set_ai_adapter(saved)
    for p in (tmp_path / "storage").rglob("*"):
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass


def _workspace_of(eng, sid: int) -> int:
    with Session(eng) as s:
        return s.get(models.Screenshot, sid).workspace_id


def _hook_lock(monkeypatch, before=None, after=None):
    """Run callbacks around the NEXT workspace lock taken by any request."""
    real = WorkspaceRepository.lock_workspace
    armed = {"on": True}

    def wrapped(self):
        if not armed["on"]:
            return real(self)
        armed["on"] = False
        if before:
            before()
        row = real(self)
        if after:
            after()
        return row

    monkeypatch.setattr(WorkspaceRepository, "lock_workspace", wrapped)


def _archive_on_second_connection(eng, ws_id: int, sid: int):
    with Session(eng) as other:  # a separate sqlite3 connection (NullPool)
        assert VaultService(other, ws_id).archive(sid).state == "archived"


def test_archive_committed_before_acceptance_rejects_prepare(file_env, deferred_job, monkeypatch):
    """Prepare passed its request-time check; Safe Burial commits before the lock."""
    c, eng, adapter = file_env
    held, _ = deferred_job
    sid = upload(c)
    ws_id = _workspace_of(eng, sid)
    _hook_lock(monkeypatch, before=lambda: _archive_on_second_connection(eng, ws_id, sid))
    r = prepare(c, sid)
    assert r.status_code == 409 and r.json()["error"]["code"] == "screenshot_archived"
    assert counts(eng)["operations"] == 0  # no operation => no AI quota consumed
    assert held == [] and adapter.calls == 0  # nothing queued, nothing processed
    with Session(eng) as s:
        assert s.get(models.Screenshot, sid).state == "archived"


def test_archive_before_acceptance_does_not_reuse_an_existing_draft(file_env, deferred_job, monkeypatch):
    """Same race with a draft already present: archived is refused consistently (409)."""
    c, eng, _ = file_env
    held, real = deferred_job
    sid = upload(c)
    first = prepare(c, sid).json()
    real(*held.pop())
    ws_id = _workspace_of(eng, sid)
    before = counts(eng)
    _hook_lock(monkeypatch, before=lambda: _archive_on_second_connection(eng, ws_id, sid))
    r = prepare(c, sid)
    assert r.status_code == 409 and r.json()["error"]["code"] == "screenshot_archived"
    assert counts(eng) == before and held == []
    # The saved draft itself stays readable.
    lj = c.get(f"/api/screenshots/{sid}/preparations/make_notes").json()
    assert lj["status"] == "successful" and lj["operationId"] == first["operationId"]


def test_prepare_holding_the_lock_serializes_a_concurrent_archive(file_env, deferred_job, monkeypatch):
    """Prepare-first: archive on another connection blocks on SQLite's write lock
    until Prepare commits; Prepare is accepted, then the worker refuses the archived
    screenshot without processing anything."""
    c, eng, adapter = file_env
    held, real = deferred_job
    sid = upload(c)
    ws_id = _workspace_of(eng, sid)
    archiver: dict[str, object] = {}

    def start_archive_while_locked():
        t = Thread(target=lambda: _archive_on_second_connection(eng, ws_id, sid))
        t.start()
        t.join(timeout=0.5)
        archiver["blocked_while_prepare_held_lock"] = t.is_alive()
        archiver["thread"] = t

    _hook_lock(monkeypatch, after=start_archive_while_locked)
    r = prepare(c, sid)
    assert r.status_code == 202 and r.json()["reused"] is False
    t = archiver["thread"]
    t.join(timeout=10)
    assert archiver["blocked_while_prepare_held_lock"] is True
    assert not t.is_alive()
    with Session(eng) as s:
        assert s.get(models.Screenshot, sid).state == "archived"
    assert len(held) == 1 and counts(eng)["operations"] == 1
    real(*held[0])
    op = c.get(f"/api/operations/{r.json()['operationId']}").json()
    assert op["status"] == "failed" and op["errorDetail"] == "Screenshot archived"
    assert adapter.calls == 0 and counts(eng)["artifacts"] == 0
    assert prepare(c, sid).status_code == 409  # and afterwards it stays refused


def test_cross_workspace_archive_race_is_still_404(file_env, monkeypatch):
    c, eng, _ = file_env
    sid = upload(c)
    other = TestClient(c.app)
    other.get("/api/workspace")
    assert other.cookies.get("sg_workspace") != c.cookies.get("sg_workspace")
    assert prepare(other, sid).status_code == 404
    assert counts(eng)["operations"] == 0
