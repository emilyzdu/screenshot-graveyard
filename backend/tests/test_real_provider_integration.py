"""Real-provider integration through the HTTP API (Batch 6A), fully mocked.

The REAL ``OpenAIVisionAdapter`` runs end to end; only the SDK client is a
scripted stand-in that answers by ``text_format`` (the wire schema). A socket
guard proves nothing leaves the process. Covers: Upload -> Consent -> Revive ->
real analysis with an AI next step -> Prepare Calendar / Notes -> Edit ->
Approve, provider failures without corrupted data, multi-source order,
workspace isolation, and that the bytes sent are the stored originals.
"""

from __future__ import annotations

import base64
import io
import os
import socket

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app import config
from app.ai import provider
from app.ai.openai_vision_adapter import OpenAIVisionAdapter, _WireClassification, _WireEventDraft, _WireStudyNote
from app.db import models
from app.db import session as sess_mod
from app.db.base import Base
from app.main import create_app
from app.ratelimit import TokenBucketRateLimiter
from tests.test_draft_editing import EVENT_FIELDS
from tests.consent_helpers import grant_body

TRUSTED = "http://localhost:5173"
HDRS = {"Origin": TRUSTED, "X-Requested-With": "fetch"}


def png(color) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (16, 10), color).save(b, format="PNG")
    return b.getvalue()


CLASSIFY = {
    "category": "Reference/Document", "confidence": 0.86, "uncertain": False,
    "epitaph": {"text": "A poster for a robotics club meeting.",
                "visible_facts": "Robotics club meeting, Tue 8 Dec 2026, 15:00-16:30, Room 4.12",
                "inferred_intent": "Possibly saved to remember the meeting.", "uncertain": False},
    "suggested_action": "add_calendar",
}
EVENTS = {"events": [
    {"title": "Robotics club meeting", "start_date": "2026-12-08", "start_time": "15:00", "end_date": "2026-12-08",
     "end_time": "16:30", "all_day": False, "time_zone": "Europe/London", "location": "Room 4.12",
     "description": None, "date_as_shown": "Tue 8 Dec 2026", "time_as_shown": "15:00-16:30",
     "time_zone_as_shown": "Room 4.12, times in Europe/London", "uncertain_fields": ["location"]},
    {"title": "Robot showcase", "start_date": None, "start_time": None, "end_date": None, "end_time": None,
     "all_day": None, "time_zone": None, "location": None, "description": None, "date_as_shown": "Jan 12",
     "time_as_shown": None, "time_zone_as_shown": None, "uncertain_fields": []},
]}
NOTE = {"topic": "Binary search", "main_concepts": ["Halve the search range each step"],
        "extracted_code": ["while lo <= hi:\n    mid = (lo + hi) // 2"], "code_explanations": [],
        "pitfalls": ["Off-by-one when updating hi"], "uncertain_content": ["The last line is cut off"]}


class _Resp:
    def __init__(self, parsed, status="completed"):
        self.output_parsed, self.status = parsed, status


class ScriptedClient:
    """Answers by wire schema; records what was sent (decoded image bytes)."""

    def __init__(self):
        self.answers = {_WireClassification: [CLASSIFY], _WireEventDraft: [EVENTS], _WireStudyNote: [NOTE]}
        self.calls: list[dict] = []
        self.responses = self

    def parse(self, **kw):
        images = [
            base64.b64decode(p["image_url"].split(",", 1)[1])
            for p in kw["input"][1]["content"] if p["type"] == "input_image"
        ]
        labels = [p["text"] for p in kw["input"][1]["content"] if p["type"] == "input_text"]
        self.calls.append({"schema": kw["text_format"], "images": images, "labels": labels, "store": kw["store"]})
        queue = self.answers[kw["text_format"]]
        answer = queue[0] if len(queue) == 1 else queue.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return _Resp(answer)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    factory = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False, class_=Session)
    monkeypatch.setattr(sess_mod, "engine", eng)
    monkeypatch.setattr(sess_mod, "SessionLocal", factory)
    monkeypatch.setattr(config, "COOKIE_SECURE", False)
    monkeypatch.setattr(config, "STORAGE_ROOT", str(tmp_path / "storage"))
    monkeypatch.setattr(config, "TRUSTED_ORIGINS", [TRUSTED])
    monkeypatch.setattr(config, "AI_PROVIDER", "openai")
    monkeypatch.setattr(config, "OPENAI_API_KEY", "test-only-not-a-key")

    def no_network(*a, **k):
        raise AssertionError("no network connection may be made in tests")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    saved = provider.get_ai_adapter()
    client = ScriptedClient()
    adapter = OpenAIVisionAdapter(client=client, model="gpt-4.1-mini")
    monkeypatch.setattr(provider, "configure_ai_adapter", lambda: provider.set_ai_adapter(adapter) or adapter)

    def make_client():
        lim = TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0)
        wlim = TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0)
        app = create_app(workspace_session_factory=factory, rate_limiter=lim, workspace_rate_limiter=wlim)
        provider.set_ai_adapter(adapter)
        c = TestClient(app)
        c.get("/api/workspace")
        return c

    yield make_client, eng, client
    provider.set_ai_adapter(saved)
    for p in (tmp_path / "storage").rglob("*"):
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass


def upload(c, color, consent=True) -> tuple[int, bytes]:
    data = png(color)
    r = c.post("/api/screenshots", headers=HDRS, files=[("files", ("s.png", data, "image/png"))])
    sid = r.json()["results"][0]["screenshotId"]
    if consent:
        assert c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json=grant_body()).status_code == 200
    return sid, data


def done(c, op_id):
    return c.get(f"/api/operations/{op_id}").json()


def counts(eng):
    with Session(eng) as s:
        return {t.__tablename__: s.scalar(select(func.count()).select_from(t))
                for t in (models.Artifact, models.ArtifactVersion, models.SourceReference, models.Approval)}


def test_full_real_provider_flow_upload_consent_revive_prepare_edit_approve(env):
    make_client, eng, client = env
    c = make_client()
    assert c.get("/api/ai/provider-mode").json()["mode"] == "openai"
    sid, data = upload(c, (200, 10, 10))

    # Revive: one real-adapter call with the stored original bytes.
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    assert done(c, op)["status"] == "successful"
    assert client.calls[-1]["schema"] is _WireClassification and client.calls[-1]["images"] == [data]
    assert client.calls[-1]["store"] is False
    a = c.get(f"/api/screenshots/{sid}/analysis").json()
    assert a["classification"]["category"] == "Reference/Document"
    assert a["classification"]["suggestedAction"] == "add_calendar"
    assert a["epitaph"]["text"] == "A poster for a robotics club meeting."
    assert a["epitaph"]["inferredIntent"].startswith("Possibly")

    # Prepare Calendar: grounded fields, the other visible event listed, not merged.
    prep = c.post(f"/api/screenshots/{sid}/preparations", headers=HDRS, json={"action": "add_calendar"}).json()
    assert prep["provider"] == "openai"
    st = done(c, prep["operationId"])
    assert st["status"] == "uncertain"  # location is marked uncertain; description missing
    aid = st["artifactId"]
    v1 = c.get(f"/api/event-drafts/{aid}").json()
    content = v1["content"]
    assert (content["title"], content["start_date"], content["start_time"], content["time_zone"]) == (
        "Robotics club meeting", "2026-12-08", "15:00", "Europe/London")
    assert content["uncertain_fields"] == ["location"] and content["references"] == [sid]
    assert content["other_events"] == ["Robot showcase · Jan 12"]
    assert client.calls[-1]["images"] == [data]

    # Edit: the user adds a description; a new version keeps what else was shown
    # (and the unchanged, still-uncertain AI location stays uncertain).
    edited = {f: content[f] for f in EVENT_FIELDS} | {"description": "Bring the robot arm."}
    body = {"baseVersionId": v1["versionId"], "content": edited, "uncertainFields": []}
    r = c.post(f"/api/event-drafts/{aid}/edits", headers=HDRS, json=body)
    assert r.status_code == 200, r.text
    v2 = r.json()
    assert v2["versionNumber"] == 2 and v2["content"]["other_events"] == ["Robot showcase · Jan 12"]

    # Approve v2: an explicit decision; no provider call, nothing sent anywhere.
    calls = len(client.calls)
    r = c.post(f"/api/artifacts/{aid}/approvals", headers=HDRS,
               json={"versionId": v2["versionId"], "confirmReviewed": True, "acknowledgeUncertain": ["location"]})
    assert r.status_code == 201, r.text
    assert r.json()["approval"]["acknowledgedUncertain"] == ["location"]
    assert len(client.calls) == calls
    assert c.get(f"/api/artifacts/{aid}/approval").json()["status"] == "current_approved"


def test_make_notes_and_multi_source_notes_use_real_content_in_source_order(env):
    make_client, eng, client = env
    c = make_client()
    a, a_bytes = upload(c, (1, 100, 1))
    b, b_bytes = upload(c, (1, 1, 100))
    prep = c.post(f"/api/screenshots/{a}/preparations", headers=HDRS, json={"action": "make_notes"}).json()
    st = done(c, prep["operationId"])
    assert st["status"] == "uncertain"  # the note has an Uncertain section
    note = c.get(f"/api/study-notes/{st['artifactId']}").json()
    assert note["content"]["topic"] == "Binary search"
    assert note["content"]["extracted_code"] == ["while lo <= hi:\n    mid = (lo + hi) // 2"]
    assert note["content"]["uncertain_content"] == ["The last line is cut off"]
    assert note["content"]["references"] == [a]

    op = c.post("/api/study-notes", headers=HDRS, json={"screenshotIds": [b, a]}).json()["operationId"]
    st = done(c, op)
    multi = c.get(f"/api/study-notes/{st['artifactId']}").json()
    assert multi["content"]["references"] == [b, a]
    assert client.calls[-1]["images"] == [b_bytes, a_bytes]
    assert client.calls[-1]["labels"] == [f"Screenshot ID: {b}", f"Screenshot ID: {a}"]


@pytest.mark.parametrize("failure, detail", [
    (type("RateLimitError", (Exception,), {})("429"), "AI provider busy; try again later"),
    (type("APITimeoutError", (Exception,), {})("slow"), "AI analysis timed out"),
    (type("InternalServerError", (Exception,), {})("500"), "AI analysis failed"),
    ({"events": [{"title": "x"}]}, "AI output failed validation"),  # malformed: missing fields
])
def test_provider_failures_save_nothing_and_a_retry_works(env, failure, detail):
    make_client, eng, client = env
    c = make_client()
    sid, _ = upload(c, (9, 9, 90))
    before = counts(eng)
    client.answers[_WireEventDraft] = [failure, EVENTS]
    prep = c.post(f"/api/screenshots/{sid}/preparations", headers=HDRS, json={"action": "add_calendar"}).json()
    st = done(c, prep["operationId"])
    assert st["status"] == "failed" and st["errorDetail"] == detail and st.get("artifactId") is None
    assert counts(eng) == before
    retry = c.post(f"/api/screenshots/{sid}/preparations", headers=HDRS, json={"action": "add_calendar"}).json()
    assert retry["operationId"] != prep["operationId"]
    assert done(c, retry["operationId"])["artifactId"] is not None


def test_a_refused_or_truncated_answer_saves_nothing(env):
    make_client, eng, client = env
    c = make_client()
    sid, _ = upload(c, (90, 9, 9))
    before = counts(eng)

    class Truncated(ScriptedClient):
        def parse(self, **kw):
            super().parse(**kw)
            return _Resp(CLASSIFY, status="incomplete")

    adapter = OpenAIVisionAdapter(client=Truncated(), model="gpt-4.1-mini")
    provider.set_ai_adapter(adapter)
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    assert done(c, op)["status"] == "failed" and done(c, op)["errorDetail"] == "AI analysis failed"
    assert counts(eng) == before


def test_no_consent_and_foreign_screenshots_never_reach_the_provider(env):
    make_client, eng, client = env
    owner, stranger = make_client(), make_client()
    sid, _ = upload(owner, (5, 50, 5), consent=False)
    assert owner.post(f"/api/screenshots/{sid}/classify", headers=HDRS).status_code == 403
    assert owner.post(f"/api/screenshots/{sid}/preparations", headers=HDRS, json={"action": "add_calendar"}).status_code == 403
    assert owner.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json=grant_body()).status_code == 200
    for r in (stranger.post(f"/api/screenshots/{sid}/classify", headers=HDRS),
              stranger.post(f"/api/screenshots/{sid}/preparations", headers=HDRS, json={"action": "make_notes"}),
              stranger.get(f"/api/screenshots/{sid}/analysis")):
        assert r.status_code == 404
    assert client.calls == []


def test_withdrawn_consent_blocks_new_requests_and_existing_approvals_are_untouched(env):
    make_client, eng, client = env
    c = make_client()
    sid, _ = upload(c, (7, 7, 70))
    prep = c.post(f"/api/screenshots/{sid}/preparations", headers=HDRS, json={"action": "add_calendar"}).json()
    aid = done(c, prep["operationId"])["artifactId"]
    v1 = c.get(f"/api/event-drafts/{aid}").json()
    edited = {f: v1["content"][f] for f in EVENT_FIELDS} | {"description": "Bring the robot arm."}
    body = {"baseVersionId": v1["versionId"], "content": edited, "uncertainFields": []}
    v2 = c.post(f"/api/event-drafts/{aid}/edits", headers=HDRS, json=body).json()
    assert c.post(f"/api/artifacts/{aid}/approvals", headers=HDRS,
                  json={"versionId": v2["versionId"], "confirmReviewed": True,
                        "acknowledgeUncertain": ["location"]}).status_code == 201
    with Session(eng) as s:
        ledger = [(a.id, a.artifact_version_id, a.content_sha256) for a in s.scalars(select(models.Approval))]
    calls = len(client.calls)
    assert c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json={"granted": False}).status_code == 200
    assert c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).status_code == 403
    assert len(client.calls) == calls
    with Session(eng) as s:
        assert [(a.id, a.artifact_version_id, a.content_sha256) for a in s.scalars(select(models.Approval))] == ledger
    assert c.get(f"/api/artifacts/{aid}/approval").json()["status"] == "current_approved"


def test_a_fake_mode_consent_reads_as_not_granted_in_real_mode_and_blocks_sending(env, monkeypatch):
    make_client, eng, client = env
    c = make_client()
    monkeypatch.setattr(config, "AI_PROVIDER", "fake")
    sid, _ = upload(c, (3, 30, 3))  # granted under the Fake AI disclosure
    monkeypatch.setattr(config, "AI_PROVIDER", "openai")
    assert c.get(f"/api/screenshots/{sid}/consent").json()["granted"] is False
    assert c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).status_code == 403
    assert c.post(f"/api/screenshots/{sid}/preparations", headers=HDRS, json={"action": "make_notes"}).status_code == 403
    assert client.calls == []
    assert c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json=grant_body()).json()["granted"] is True
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    assert done(c, op)["status"] == "successful" and len(client.calls) == 1
