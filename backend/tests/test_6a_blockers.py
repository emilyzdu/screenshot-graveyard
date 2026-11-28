"""Batch 6A Codex release blockers P1-A .. P2-F (written to fail before the fix).

Disposable SQLite only, separate connections where order matters, a local mock
HTTP server for the real OpenAI SDK, and no real credentials or images. No test
prints image bytes, data URLs or keys: assertions only check for ABSENCE.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import socket
import threading
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import NullPool, StaticPool

from app import config
from app.ai import provider
from app.ai.fake_adapter import FakeAIAdapter
from app.ai.openai_vision_adapter import OpenAIVisionAdapter
from app.ai.schemas import Category, ClassificationResult, EpitaphPayload
from app.db import models
from app.db import session as sess_mod
from app.db.base import Base
from app.main import create_app
from app.ratelimit import TokenBucketRateLimiter
from app.services.ai_dispatch_service import AIDispatchService
from app.services.operation_service import OperationService
from app.services.vault_service import VaultService
from app.storage.file_store import FileStore
from tests.test_real_provider_integration import CLASSIFY, EVENTS, NOTE, ScriptedClient

TRUSTED = "http://localhost:5173"
HDRS = {"Origin": TRUSTED, "X-Requested-With": "fetch"}


def png(color=(9, 9, 9), *, sentinel: bytes | None = None) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(b, format="PNG")
    data = b.getvalue()
    if sentinel is None:
        return data
    # Insert a tEXt chunk (still a valid PNG) carrying the sentinel.
    body = b"Comment\x00" + sentinel
    chunk = len(body).to_bytes(4, "big") + b"tEXt" + body + zlib.crc32(b"tEXt" + body).to_bytes(4, "big")
    return data[:33] + chunk + data[33:]


# ======================================================================= HTTP env
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
    monkeypatch.setattr(config, "AI_PROVIDER", "fake")
    monkeypatch.setattr(config, "OPENAI_API_KEY", "test-only-not-a-key")
    saved = provider.get_ai_adapter()
    scripted = ScriptedClient()
    real = OpenAIVisionAdapter(client=scripted, model="gpt-4.1-mini")
    fake = FakeAIAdapter()
    monkeypatch.setattr(provider, "configure_ai_adapter", lambda: provider.get_ai_adapter())

    def use(mode):
        monkeypatch.setattr(config, "AI_PROVIDER", mode)
        provider.set_ai_adapter(real if mode == "openai" else fake)

    def make_client():
        lim = TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0)
        wlim = TokenBucketRateLimiter(capacity=10_000, refill_per_sec=1000.0)
        app = create_app(workspace_session_factory=factory, rate_limiter=lim, workspace_rate_limiter=wlim)
        c = TestClient(app)
        c.get("/api/workspace")
        return c

    use("fake")
    yield make_client, eng, scripted, use
    provider.set_ai_adapter(saved)
    for p in (tmp_path / "storage").rglob("*"):
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass


def upload(c, color) -> int:
    r = c.post("/api/screenshots", headers=HDRS, files=[("files", ("s.png", png(color), "image/png"))])
    return r.json()["results"][0]["screenshotId"]


def shown_disclosure(c) -> dict:
    """What the browser displayed: the server's current disclosure contract."""
    r = c.get("/api/ai/disclosure")
    return r.json() if r.status_code == 200 else {}


def grant(c, sid, disclosure: dict | None):
    body = {"granted": True}
    if disclosure:
        body |= {"provider": disclosure["provider"], "disclosureRevision": disclosure["revision"]}
    return c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json=body)


def consent_rows(eng):
    with Session(eng) as s:
        return [(r.screenshot_id, r.granted) for r in s.scalars(select(models.ConsentRecord))]


# ======================================================================= P1-A
def test_p1a_a_grant_made_under_the_fake_disclosure_is_refused_after_a_switch_to_openai(env):
    """The reproduction: the browser shows the Fake disclosure, the server switches
    to OpenAI, the old consent POST arrives. It must be refused, and nothing sent."""
    make_client, eng, scripted, use = env
    c = make_client()
    sid = upload(c, (1, 2, 3))
    seen = shown_disclosure(c)           # Fake disclosure displayed (or nothing pre-fix)
    use("openai")                         # server reconfigured meanwhile
    r = grant(c, sid, seen)
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "disclosure_changed"
    current = r.json()["disclosure"]
    assert current["provider"] == "openai" and current["revision"] and current["text"]
    assert consent_rows(eng) == []        # nothing recorded
    assert c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).status_code == 403
    assert scripted.calls == []


def test_p1a_a_bare_grant_without_disclosure_values_is_refused(env):
    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (2, 2, 3))
    r = c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json={"granted": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "disclosure_changed"
    assert consent_rows(eng) == []


def test_p1a_openai_to_fake_switch_also_rejects_the_stale_disclosure(env):
    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (3, 2, 3))
    seen = shown_disclosure(c)
    use("fake")
    r = grant(c, sid, seen)
    assert r.status_code == 409 and r.json()["disclosure"]["provider"] == "fake"
    assert consent_rows(eng) == []
    assert grant(c, sid, shown_disclosure(c)).status_code == 200  # a fresh explicit grant works


def test_p1a_a_revised_disclosure_for_the_same_provider_needs_a_fresh_grant(env, monkeypatch):
    from app.ai import disclosure as disclosure_mod

    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (4, 2, 3))
    old = shown_disclosure(c)
    assert grant(c, sid, old).status_code == 200
    # The OpenAI disclosure is materially revised (same provider).
    monkeypatch.setitem(disclosure_mod.DISCLOSURE_TEXT, "openai", disclosure_mod.DISCLOSURE_TEXT["openai"] + " Revised.")
    new = shown_disclosure(c)
    assert new["revision"] != old["revision"]
    assert c.get(f"/api/screenshots/{sid}/consent").json()["granted"] is False  # old grant no longer covers it
    assert c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).status_code == 403
    assert scripted.calls == []
    assert grant(c, sid, old).status_code == 409                      # the stale revision is refused
    assert grant(c, sid, new).status_code == 200
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    assert c.get(f"/api/operations/{op}").json()["status"] == "successful" and len(scripted.calls) == 1


def test_p1a_the_dispatch_guard_independently_rejects_a_grant_for_a_revised_disclosure(env, monkeypatch):
    """Even a consent row written for an older revision (e.g. before the revision
    changed during a long-running worker) never authorizes the call."""
    from app.ai import disclosure as disclosure_mod

    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (5, 2, 3))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    with Session(eng) as s:
        ws = s.get(models.Screenshot, sid).workspace_id
        op = OperationService(s, ws).create_pending("classify").operation_id
    monkeypatch.setitem(disclosure_mod.DISCLOSURE_TEXT, "openai", "Materially different text.")
    with Session(eng) as s:
        from app.services.ai_dispatch_service import DispatchConsentRequiredError

        with pytest.raises(DispatchConsentRequiredError):
            AIDispatchService(s, ws).authorize(op, [sid])


def test_p1a_withdrawal_never_needs_a_disclosure(env):
    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (6, 2, 3))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    use("fake")  # even with a stale view, withdrawing always works
    r = c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json={"granted": False})
    assert r.status_code == 200 and r.json()["granted"] is False


def test_p1a_the_client_cannot_pick_the_provider(env):
    """Sending the OpenAI provider id while the server is in Fake mode (or any made-up
    provider) is never permission for anything."""
    make_client, eng, scripted, use = env
    c = make_client()
    sid = upload(c, (7, 2, 3))
    fake = shown_disclosure(c)
    for body in ({"provider": "openai", "disclosureRevision": fake.get("revision", "x")},
                 {"provider": "other", "disclosureRevision": "anything"},
                 {"provider": "fake", "disclosureRevision": "not-the-current-one"}):
        r = c.post(f"/api/screenshots/{sid}/consent", headers=HDRS, json={"granted": True, **body})
        assert r.status_code == 409, body
    assert consent_rows(eng) == []


# ======================================================================= P1-B
class _MockResponses(BaseHTTPRequestHandler):
    status = 200

    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if type(self).status != 200:
            body = json.dumps({"error": {"message": "server error", "type": "server_error"}}).encode()
            self.send_response(type(self).status)
        else:
            body = json.dumps({
                "id": "resp_t", "object": "response", "created_at": 0, "status": "completed", "model": "gpt-4.1-mini",
                "output": [{"id": "msg_t", "type": "message", "status": "completed", "role": "assistant",
                            "content": [{"type": "output_text", "text": json.dumps(CLASSIFY), "annotations": []}]}],
                "parallel_tool_calls": False, "tool_choice": "auto", "tools": [],
            }).encode()
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture()
def mock_http():
    server = HTTPServer(("127.0.0.1", 0), _MockResponses)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1", _MockResponses
    server.shutdown()
    _MockResponses.status = 200


@pytest.fixture()
def captured_logs():
    """Every record from the SDK/HTTP loggers, formatted, at DEBUG, as any handler would see it."""
    records: list[str] = []

    class Capture(logging.Handler):
        def emit(self, record):
            records.append(self.format(record) + (" " + logging.Formatter().formatException(record.exc_info)
                                                  if record.exc_info else ""))

    handler = Capture(level=logging.DEBUG)
    root = logging.getLogger()
    names = ("openai", "openai._base_client", "httpx", "httpcore")
    old = {n: logging.getLogger(n).level for n in names}
    old_root = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    for n in names:
        logging.getLogger(n).setLevel(logging.DEBUG)
    yield records
    root.removeHandler(handler)
    root.setLevel(old_root)
    for n, lvl in old.items():
        logging.getLogger(n).setLevel(lvl)


SENTINEL = b"SG6A-SENTINEL-7Q2Z-DO-NOT-LOG"
KEY = "sk-test-SG6A-KEYSENTINEL-9X"


def _forbidden(image: bytes) -> list[str]:
    b64 = base64.b64encode(image).decode()
    return [SENTINEL.decode(), b64[:40], b64[-40:], "data:image/png;base64,", KEY, "KEYSENTINEL"]


def test_p1b_sdk_debug_logging_never_records_the_image_or_the_key(mock_http, captured_logs):
    from openai import OpenAI

    base_url, _ = mock_http
    image = png(sentinel=SENTINEL)
    adapter = OpenAIVisionAdapter(client=OpenAI(api_key=KEY, base_url=base_url, max_retries=0, timeout=5),
                                  model="gpt-4.1-mini")
    result = adapter.classify_and_epitaph(image, "image/png")
    assert result.category.value == "Reference/Document"  # a real SDK round trip happened
    assert captured_logs, "the SDK/HTTP loggers emitted nothing; the test would prove nothing"
    joined = "\n".join(captured_logs)
    leaked = [f for f in _forbidden(image) if f in joined]
    assert leaked == [], f"{len(leaked)} sensitive marker(s) reached the logs"


def test_p1b_errors_and_retries_never_log_the_image_or_the_key(mock_http, captured_logs):
    from openai import OpenAI

    from app.ai.adapter import AIAdapterError

    base_url, handler = mock_http
    handler.status = 500
    image = png((1, 1, 1), sentinel=SENTINEL)
    # The SDK retry path too (the app itself always uses max_retries=0).
    adapter = OpenAIVisionAdapter(client=OpenAI(api_key=KEY, base_url=base_url, max_retries=1, timeout=5),
                                  model="gpt-4.1-mini")
    with pytest.raises(AIAdapterError) as raised:
        adapter.classify_and_epitaph(image, "image/png")
    joined = "\n".join(captured_logs) + str(raised.value) + repr(raised.value)
    leaked = [f for f in _forbidden(image) if f in joined]
    assert leaked == [], f"{len(leaked)} sensitive marker(s) reached the logs or the error"


def test_p1b_sanitized_diagnostics_survive_and_other_loggers_are_untouched(mock_http, captured_logs):
    from openai import OpenAI

    base_url, _ = mock_http
    adapter = OpenAIVisionAdapter(client=OpenAI(api_key=KEY, base_url=base_url, max_retries=0, timeout=5),
                                  model="gpt-4.1-mini")
    adapter.classify_and_epitaph(png(sentinel=SENTINEL), "image/png")
    joined = "\n".join(captured_logs)
    assert "Sending HTTP Request: POST" in joined and "/v1/responses" in joined  # request category kept
    assert "200 OK" in joined                                                      # status code kept
    assert "Request options: [redacted by Screenshot Graveyard" in joined
    logging.getLogger("app.unrelated").warning("data:image/png;base64,AAAA kept as-is outside scope")
    assert "data:image/png;base64,AAAA kept as-is" in captured_logs[-1]


# ======================================================================= P2-C
def _e(**over):
    base = {"title": "Talk", "start_date": None, "start_time": None, "end_date": None, "end_time": None,
            "all_day": None, "time_zone": None, "location": None, "description": None,
            "date_as_shown": None, "time_as_shown": None, "time_zone_as_shown": None, "uncertain_fields": []}
    base.update(over)
    return base


def _draft(*events):
    class R:
        def __init__(self, parsed):
            self.output_parsed, self.status = parsed, "completed"

    class C:
        class responses:
            parsed = None

            @classmethod
            def parse(cls, **kw):
                return R(cls.parsed)

    C.responses.parsed = {"events": list(events)}
    return OpenAIVisionAdapter(client=C, model="m").event_draft([(7, b"png", "image/png")])


def test_p2c_a_year_the_screenshot_does_not_show_is_never_kept():
    d = _draft(_e(start_date="2026-01-12", end_date="2026-01-12", all_day=True, date_as_shown="Jan 12"))
    assert d.start_date is None and d.end_date is None and "start_date" in d.missing_fields
    assert "Date shown: Jan 12" in (d.description or "")


def test_p2c_a_contradictory_year_is_never_kept():
    d = _draft(_e(start_date="2026-01-12", all_day=True, date_as_shown="12 January 2027"))
    assert d.start_date is None


def test_p2c_a_date_with_no_evidence_at_all_is_never_kept():
    d = _draft(_e(start_date="2026-01-12", all_day=True))
    assert d.start_date is None


def test_p2c_a_time_with_no_evidence_is_never_kept():
    d = _draft(_e(start_date="2027-01-12", end_date="2027-01-12", start_time="15:00", end_time="16:00",
                  all_day=False, time_zone="Europe/London", date_as_shown="12 Jan 2027",
                  time_zone_as_shown="Europe/London"))
    assert d.start_time is None and d.end_time is None


def test_p2c_a_time_that_does_not_match_its_evidence_is_never_kept():
    d = _draft(_e(start_date="2027-01-12", end_date="2027-01-12", start_time="16:00", all_day=False,
                  time_zone="Europe/London", date_as_shown="12 Jan 2027", time_as_shown="3pm",
                  time_zone_as_shown="London time"))
    assert d.start_time is None


def test_p2c_a_time_zone_with_no_evidence_is_never_kept():
    d = _draft(_e(start_date="2027-01-12", end_date="2027-01-12", start_time="15:00", end_time="16:00",
                  all_day=False, time_zone="Europe/London", date_as_shown="12 Jan 2027", time_as_shown="15:00-16:00"))
    assert d.time_zone is None and d.start_time is None
    assert "Time shown: 15:00-16:00; no time zone was shown." in d.description


def test_p2c_a_full_explicit_date_time_and_zone_are_kept():
    d = _draft(_e(start_date="2027-01-12", end_date="2027-01-12", start_time="15:00", end_time="16:30",
                  all_day=False, time_zone="Europe/London", date_as_shown="Tuesday 12 January 2027",
                  time_as_shown="3pm - 4:30pm", time_zone_as_shown="London time"))
    assert (d.start_date, d.end_date, d.start_time, d.end_time, d.time_zone) == (
        "2027-01-12", "2027-01-12", "15:00", "16:30", "Europe/London")
    assert d.uncertain_fields == []


def test_p2c_an_explicit_iana_zone_and_24h_times_are_kept():
    d = _draft(_e(start_date="2027-03-04", end_date="2027-03-04", start_time="09:00", end_time="10:00",
                  all_day=False, time_zone="America/New_York", date_as_shown="4 March 2027",
                  time_as_shown="09:00-10:00", time_zone_as_shown="America/New_York"))
    assert (d.start_time, d.time_zone) == ("09:00", "America/New_York")


def test_p2c_a_contradictory_zone_is_never_kept():
    d = _draft(_e(start_date="2027-03-04", end_date="2027-03-04", start_time="09:00", end_time="10:00",
                  all_day=False, time_zone="Europe/Paris", date_as_shown="4 March 2027",
                  time_as_shown="09:00-10:00", time_zone_as_shown="New York time"))
    assert d.time_zone is None and d.start_time is None
    assert "Time zone shown: New York time." in d.description


def test_p2c_numeric_day_month_order_and_12_hour_guesses_are_marked_uncertain():
    d = _draft(_e(start_date="2027-03-04", end_date="2027-03-04", start_time="15:00", end_time="16:00",
                  all_day=False, time_zone="Europe/London", date_as_shown="04/03/2027",
                  time_as_shown="3:00-4:00", time_zone_as_shown="London"))
    assert d.start_date == "2027-03-04" and {"start_date", "start_time", "end_time"} <= set(d.uncertain_fields)


def test_p2c_ambiguous_dst_stays_uncertain_and_nonexistent_stays_blank():
    fold = _draft(_e(start_date="2026-10-25", end_date="2026-10-25", start_time="01:30", end_time="02:30",
                     all_day=False, time_zone="Europe/London", date_as_shown="25 Oct 2026",
                     time_as_shown="01:30-02:30", time_zone_as_shown="Europe/London"))
    assert fold.start_time == "01:30" and "start_time" in fold.uncertain_fields
    gap = _draft(_e(start_date="2026-03-29", end_date="2026-03-29", start_time="01:30", end_time="03:00",
                    all_day=False, time_zone="Europe/London", date_as_shown="29 Mar 2026",
                    time_as_shown="01:30-03:00", time_zone_as_shown="Europe/London"))
    assert gap.start_time is None and "does not exist in Europe/London" in gap.description


def test_p2c_multiple_events_with_incomplete_details_are_listed_not_completed():
    d = _draft(
        _e(title="Seminar", start_date="2026-01-12", all_day=True, date_as_shown="Jan 12"),
        _e(title="Lab", start_date=None, date_as_shown="Jan 19"),
    )
    assert d.start_date is None and d.title == "Seminar"
    assert d.other_events == ["Lab · Jan 19"]


def test_p2c_an_incomplete_draft_is_persisted_editable_with_truthful_provenance(env):
    """Validation happens before persistence: the stored v1 never holds the
    unsupported year, and the user can complete it with an edit."""
    from tests.test_draft_editing import EVENT_FIELDS

    make_client, eng, scripted, use = env
    use("openai")
    scripted.answers[__import__("app.ai.openai_vision_adapter", fromlist=["x"])._WireEventDraft] = [
        {"events": [_e(title="Seminar", start_date="2026-01-12", end_date="2026-01-12", all_day=True,
                       date_as_shown="Jan 12")]}]
    c = make_client()
    sid = upload(c, (30, 1, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    prep = c.post(f"/api/screenshots/{sid}/preparations", headers=HDRS, json={"action": "add_calendar"}).json()
    aid = c.get(f"/api/operations/{prep['operationId']}").json()["artifactId"]
    v1 = c.get(f"/api/event-drafts/{aid}").json()
    assert v1["content"]["start_date"] is None and "start_date" in v1["content"]["missing_fields"]
    with Session(eng) as s:
        assert "2026-01-12" not in s.scalars(select(models.ArtifactVersion.content_json)).one()
    edited = {f: v1["content"][f] for f in EVENT_FIELDS} | {"start_date": "2027-01-12", "end_date": "2027-01-12"}
    r = c.post(f"/api/event-drafts/{aid}/edits", headers=HDRS,
               json={"baseVersionId": v1["versionId"], "content": edited, "uncertainFields": []})
    assert r.status_code == 200 and r.json()["fieldOrigins"]["start_date"]["origin"] == "manual_edit"


# ======================================================================= P2-D
@pytest.mark.parametrize("category", ["Potentially Sensitive", "Unknown/Needs Review"])
@pytest.mark.parametrize("action", ["add_calendar", "make_notes"])
def test_p2d_the_adapter_never_returns_a_suggestion_for_a_blocked_category(category, action):
    class R:
        output_parsed = {**CLASSIFY, "category": category, "suggested_action": action}
        status = "completed"

    class C:
        class responses:
            @staticmethod
            def parse(**kw):
                return R()

    out = OpenAIVisionAdapter(client=C, model="m").classify_and_epitaph(b"png", "image/png")
    assert out.suggested_action is None


@pytest.mark.parametrize("category", [Category.POTENTIALLY_SENSITIVE, Category.UNKNOWN_NEEDS_REVIEW])
def test_p2d_a_blocked_suggestion_is_never_persisted_or_returned(env, category):
    make_client, eng, scripted, use = env

    class Suggests:
        provider_id = "fake"

        def classify_and_epitaph(self, b, m, *, instructions=None):
            return ClassificationResult(category=category, confidence=0.9, uncertain=False,
                                        epitaph=EpitaphPayload(text="x", visible_facts="", inferred_intent=None),
                                        suggested_action="add_calendar")

    provider.set_ai_adapter(Suggests())
    c = make_client()
    sid = upload(c, (8, 8, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    assert c.get(f"/api/operations/{op}").json()["status"] == "successful"
    with Session(eng) as s:
        stored = [json.loads(v.content_json) for v in s.scalars(select(models.ArtifactVersion))]
    assert all("suggested_action" not in p for p in stored)
    assert c.get(f"/api/screenshots/{sid}/analysis").json()["classification"]["suggestedAction"] is None


def test_p2d_a_legacy_stored_incompatible_suggestion_is_not_returned(env):
    make_client, eng, scripted, use = env
    c = make_client()
    sid = upload(c, (9, 8, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    c.get(f"/api/operations/{op}")
    with eng.begin() as conn:  # an older row written before the policy existed
        conn.execute(text("update artifact_version set content_json = :j where artifact_id = "
                          "(select id from artifact where kind = 'classification')"),
                     {"j": json.dumps({"category": "Potentially Sensitive", "confidence": 0.9, "uncertain": False,
                                       "suggested_action": "add_calendar"})})
    assert c.get(f"/api/screenshots/{sid}/analysis").json()["classification"]["suggestedAction"] is None


@pytest.mark.parametrize("category, action, kept", [
    ("Reference/Document", "add_calendar", "add_calendar"),
    ("Study/Knowledge", "make_notes", "make_notes"),
    ("Study/Knowledge", "add_calendar", "add_calendar"),
    ("Shopping/Inspiration", "make_notes", "make_notes"),
    ("Potentially Sensitive", "make_notes", None),
    ("Unknown/Needs Review", "add_calendar", None),
    ("Reference/Document", "buy_it", None),      # malformed action
    ("Made Up", "add_calendar", None),           # malformed category
    ("Reference/Document", None, None),
])
def test_p2d_the_policy_keeps_only_allowed_pairs(category, action, kept):
    from app.ai.schemas import allowed_suggestion

    assert allowed_suggestion(category, False, action) == kept
    assert allowed_suggestion(category, True, action) is None  # never for an uncertain result


def test_p2d_a_category_correction_drops_the_ai_suggestion(env):
    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (31, 1, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    c.get(f"/api/operations/{op}")
    assert c.get(f"/api/screenshots/{sid}/analysis").json()["classification"]["suggestedAction"] == "add_calendar"
    r = c.post(f"/api/screenshots/{sid}/analysis/edits", headers=HDRS, json={"category": "Potentially Sensitive"})
    assert r.status_code == 200 and r.json()["classification"]["suggestedAction"] is None
    assert r.json()["classification"]["provider"] is None and r.json()["classification"]["origin"] == "manual_edit"


# ======================================================================= P2-E
def test_p2e_a_fake_analysis_stays_fake_after_a_switch_to_openai(env):
    make_client, eng, scripted, use = env
    c = make_client()
    sid = upload(c, (10, 8, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    assert c.get(f"/api/operations/{op}").json()["status"] == "successful"
    use("openai")
    a = c.get(f"/api/screenshots/{sid}/analysis").json()
    assert a["classification"]["provider"] == "fake" and a["epitaph"]["provider"] == "fake"


def test_p2e_an_openai_analysis_stays_openai_after_a_switch_to_fake_and_redo_records_its_own(env):
    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (11, 8, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    assert c.get(f"/api/operations/{op}").json()["status"] == "successful"
    use("fake")
    assert c.get(f"/api/screenshots/{sid}/analysis").json()["classification"]["provider"] == "openai"
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    r = c.post(f"/api/screenshots/{sid}/analysis/redo", headers=HDRS, json={"instructions": "shorter"})
    assert r.status_code == 202, r.text
    assert c.get(f"/api/operations/{r.json()['operationId']}").json()["status"] == "successful"
    a = c.get(f"/api/screenshots/{sid}/analysis").json()
    assert a["classification"]["versionNumber"] == 2 and a["classification"]["provider"] == "fake"
    with Session(eng) as s:
        providers = [json.loads(v.content_json).get("provider") for v in
                     s.scalars(select(models.ArtifactVersion).order_by(models.ArtifactVersion.id))]
    assert providers[:2] == ["openai", "openai"] and providers[-2:] == ["fake", "fake"]


def test_p2e_a_legacy_analysis_without_provenance_reports_an_unknown_provider(env):
    make_client, eng, scripted, use = env
    c = make_client()
    sid = upload(c, (12, 8, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    c.get(f"/api/operations/{op}")
    with eng.begin() as conn:
        conn.execute(text("update artifact_version set content_json = json_remove(content_json, '$.provider')"))
    a = c.get(f"/api/screenshots/{sid}/analysis").json()
    assert a["classification"]["provider"] is None and a["epitaph"]["provider"] is None


def test_p2e_an_adapter_for_another_provider_than_configured_is_never_dispatched(env):
    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (13, 8, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    provider.set_ai_adapter(FakeAIAdapter())  # mismatch: config says openai, adapter is fake
    op = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    st = c.get(f"/api/operations/{op}").json()
    assert st["status"] == "failed" and st["errorDetail"] == "AI processing unavailable"


# ======================================================================= P2-F
@pytest.fixture()
def disk(tmp_path):
    url = f"sqlite:///{(tmp_path / 'r.db').as_posix()}"
    eng = create_engine(url, poolclass=NullPool, connect_args={"check_same_thread": False, "timeout": 10})
    Base.metadata.create_all(eng)
    store = FileStore(tmp_path / "storage")
    with Session(eng) as s:
        ws = models.Workspace(token_hash="f" * 64)
        s.add(ws)
        s.commit()
        wid = ws.id
    yield eng, store, wid
    for p in (tmp_path / "storage").rglob("*"):
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass


def _claimed(eng, store, wid, n=1):
    from app.services.consent_service import ConsentService

    with Session(eng) as s:
        sids = [VaultService(s, wid, file_store=store).upload(png((20 + i, 1, 1)), filename="x.png").screenshot_id
                for i in range(n)]
        for sid in sids:
            try:
                from tests.consent_helpers import current_disclosure

                ConsentService(s, wid).record_consent(sid, True, disclosure=current_disclosure())
            except ImportError:  # before the P1-A fix the service took no disclosure
                ConsentService(s, wid).record_consent(sid, True)
        op = OperationService(s, wid).create_pending("study_note" if n > 1 else "classify").operation_id
    with Session(eng) as s:
        ticket = AIDispatchService(s, wid).authorize(op, sids)
    return op, sids, ticket


def _rows(eng, op):
    with Session(eng) as s:
        return [(r.state, r.completed_at is not None) for r in
                s.scalars(select(models.AIDispatch).where(models.AIDispatch.operation_id == op))]


def _sweep(eng, wid):
    from datetime import datetime, timedelta, timezone

    with Session(eng) as s:
        return OperationService(s, wid).fail_stale_pending(1, now=datetime.now(timezone.utc) + timedelta(hours=1))


@pytest.mark.parametrize("n", [1, 3])
def test_p2f_recovery_finalizes_the_dispatch_audit_in_the_same_transaction(disk, n):
    eng, store, wid = disk
    op, sids, _ = _claimed(eng, store, wid, n)  # the worker crashed after claiming
    assert _sweep(eng, wid) == 1
    with Session(eng) as s:
        assert s.get(models.Operation, op).status == "failed"
    assert _rows(eng, op) == [("interrupted", True)] * n  # may have been sent; result never saved


def test_p2f_a_late_completion_after_recovery_saves_nothing(disk):
    eng, store, wid = disk
    op, sids, ticket = _claimed(eng, store, wid)
    _sweep(eng, wid)
    with Session(eng) as s:
        from app.services.operation_service import OperationTransitionError

        with pytest.raises(OperationTransitionError):
            OperationService(s, wid).complete_after_persistence(
                op, lambda: None, guard=lambda: AIDispatchService(s, wid).verify_for_persistence(ticket))
    with Session(eng) as s:
        AIDispatchService(s, wid).discard(ticket)  # the worker's cleanup must not overwrite the audit
    assert _rows(eng, op) == [("interrupted", True)]


def test_p2f_repeated_recovery_is_idempotent(disk):
    eng, store, wid = disk
    op, sids, _ = _claimed(eng, store, wid)
    assert _sweep(eng, wid) == 1
    first = _rows(eng, op)
    assert _sweep(eng, wid) == 0
    assert _rows(eng, op) == first


def test_p2f_a_completed_operation_is_never_touched_by_recovery(disk):
    eng, store, wid = disk
    op, sids, ticket = _claimed(eng, store, wid)
    with Session(eng) as s:
        OperationService(s, wid).complete_after_persistence(
            op, lambda: None, guard=lambda: AIDispatchService(s, wid).verify_for_persistence(ticket))
    assert _sweep(eng, wid) == 0
    assert _rows(eng, op) == [("completed", True)]


def test_p2f_a_failed_recovery_rolls_back_both(disk, monkeypatch):
    eng, store, wid = disk
    op, sids, _ = _claimed(eng, store, wid)
    real_commit = Session.commit

    def boom(self):
        raise OSError("disk full")

    monkeypatch.setattr(Session, "commit", boom)
    with pytest.raises(Exception):
        _sweep(eng, wid)
    monkeypatch.setattr(Session, "commit", real_commit)
    with Session(eng) as s:
        assert s.get(models.Operation, op).status == "pending"
    assert _rows(eng, op) == [("dispatched", False)]


def test_p2f_recovery_while_the_provider_call_is_in_flight_then_a_late_result(disk):
    """The sweep fails the operation while the adapter is still out; the worker's
    late result is refused, nothing is saved, and the audit keeps 'interrupted'."""
    from app.services.classification_service import ClassificationService
    from app.services.consent_service import ConsentService
    from tests.consent_helpers import current_disclosure

    eng, store, wid = disk
    with Session(eng) as s:
        sid = VaultService(s, wid, file_store=store).upload(png((40, 1, 1)), filename="x.png").screenshot_id
        ConsentService(s, wid).record_consent(sid, True, disclosure=current_disclosure())
        op = OperationService(s, wid).create_pending("classify").operation_id

    class SweepsMidCall(FakeAIAdapter):
        def classify_and_epitaph(self, b, m, *, instructions=None):
            assert _sweep(eng, wid) == 1  # another process recovers it meanwhile
            return super().classify_and_epitaph(b, m)

    with Session(eng) as s:
        ClassificationService(s, wid, adapter=SweepsMidCall(), vault=VaultService(s, wid, file_store=store)).run_classification(sid, op)
    with Session(eng) as s:
        assert s.get(models.Operation, op).status == "failed"
        assert s.scalar(select(models.Artifact.id).limit(1)) is None
    assert _rows(eng, op) == [("interrupted", True)]


# ======================================================================= C1 (round 2)
def _prepare_event(c, scripted, sid, event):
    from app.ai.openai_vision_adapter import _WireEventDraft

    scripted.answers[_WireEventDraft] = [{"events": [event]}]
    prep = c.post(f"/api/screenshots/{sid}/preparations", headers=HDRS, json={"action": "add_calendar"}).json()
    aid = c.get(f"/api/operations/{prep['operationId']}").json()["artifactId"]
    return aid, c.get(f"/api/event-drafts/{aid}").json()


def _try_approve(c, aid, version):
    return c.post(f"/api/artifacts/{aid}/approvals", headers=HDRS, json={
        "versionId": version["versionId"], "confirmReviewed": True,
        "acknowledgeUncertain": version["content"]["uncertain_fields"]})


C1_CASES = {
    # 1. ISO evidence for a DIFFERENT day of the same month.
    "iso_other_day": _e(title="Exam", start_date="2026-02-02", end_date="2026-02-02", all_day=True,
                        date_as_shown="2026-02-13"),
    # 2. Two dates; the year of one and the day of the other.
    "mixed_fragments": _e(title="Exam", start_date="2026-01-12", end_date="2026-01-12", all_day=True,
                          date_as_shown="Jan 12, 2025; Jan 13, 2026"),
    # 3. An offset is not plain UTC.
    "offset_not_utc": _e(title="Call", start_date="2027-03-04", end_date="2027-03-04", start_time="10:00",
                         end_time="11:00", all_day=False, time_zone="UTC", date_as_shown="4 March 2027",
                         time_as_shown="10:00-11:00", time_zone_as_shown="UTC+05:30"),
}


@pytest.mark.parametrize("case", list(C1_CASES))
def test_c1_contradictory_evidence_is_never_saved_or_approvable_without_correction(env, case):
    from tests.test_draft_editing import EVENT_FIELDS

    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (50 + len(case), 1, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    aid, v1 = _prepare_event(c, scripted, sid, C1_CASES[case])
    content = v1["content"]
    if case == "offset_not_utc":
        assert content["time_zone"] is None and content["start_time"] is None
        assert "time_zone" in content["missing_fields"]
        assert "Time zone shown: UTC+05:30." in content["description"]
    else:
        assert content["start_date"] is None and "start_date" in content["missing_fields"]
    r = _try_approve(c, aid, v1)
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_approvable", r.text
    # The user completes it by hand: only then can it be approved.
    fix = {"start_date": "2027-03-04", "end_date": "2027-03-04"} if case != "offset_not_utc" else {
        "start_time": "10:00", "end_time": "11:00", "time_zone": "Asia/Kolkata"}
    edited = {f: content[f] for f in EVENT_FIELDS} | fix
    v2 = c.post(f"/api/event-drafts/{aid}/edits", headers=HDRS,
                json={"baseVersionId": v1["versionId"], "content": edited, "uncertainFields": []}).json()
    r = _try_approve(c, aid, v2)
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("iso, shown, verdict", [
    ("2026-02-13", "2026-02-13", "supported"),                      # full ISO
    ("2026-02-02", "2026-02-13", "unsupported"),                    # ISO for another day
    ("2027-01-12", "Tuesday 12 January 2027", "supported"),         # month name
    ("2027-01-12", "January 12th, 2027", "supported"),
    ("2026-12-09", "8–9 Dec 2026", "supported"),                    # a range sharing month and year
    ("2026-12-10", "8–9 Dec 2026", "unsupported"),
    ("2026-01-12", "Jan 12, 2025; Jan 13, 2026", "unsupported"),    # fragments of two dates
    ("2026-01-13", "Jan 12, 2025; Jan 13, 2026", "supported"),      # exactly one of them
    ("2026-01-12", "12 January 2027", "unsupported"),               # contradictory year
    ("2026-01-12", "Jan 12", "unsupported"),                        # no year
    ("2026-01-12", None, "unsupported"),                            # no evidence
    ("2027-03-04", "04/03/2027", "ambiguous"),                      # day/month order unknown
    ("2027-03-25", "25/03/2027", "supported"),                      # only one reading is real
    ("2027-03-04", "Mon 4/3", "unsupported"),
])
def test_c1_date_evidence_compares_whole_dates(iso, shown, verdict):
    from app.ai.openai_vision_adapter import date_evidence

    assert date_evidence(iso, shown) == verdict


@pytest.mark.parametrize("zone, shown, day, ok", [
    ("UTC", "UTC+05:30", "2027-03-04", False),           # an offset is never plain UTC
    ("UTC", "UTC", "2027-03-04", True),                  # exact UTC
    ("UTC", "times are UTC", None, True),
    ("UTC", "+05:30", "2027-03-04", False),
    ("UTC", "UTC+00:00", "2027-03-04", True),            # zero offset IS UTC
    ("Etc/GMT-5", "UTC+5", "2027-03-04", True),          # fixed offset, POSIX sign
    ("Etc/GMT-5", "UTC+05:30", "2027-03-04", False),
    ("Asia/Kolkata", "Kolkata (UTC+05:30)", "2027-03-04", True),
    ("Asia/Kolkata", "UTC+05:30", "2027-03-04", False),  # offset alone never names a region
    ("Europe/London", "London (UTC+05:30)", "2027-03-04", False),  # contradiction
    ("Europe/London", "London (UTC+01:00)", "2027-07-01", True),   # BST in July
    ("Europe/London", "London (UTC+01:00)", "2027-01-15", False),  # but not in January
    ("Europe/London", "Europe/London", None, True),      # explicit IANA
    ("America/New_York", "New York time", None, True),
    ("Europe/Paris", "New York time", None, False),
    ("Europe/London", None, None, False),                # no evidence
])
def test_c1_zone_evidence_treats_offsets_as_distinct(zone, shown, day, ok):
    """(D1: an event time is now required to check a regional offset; 10:00 here.)"""
    from app.ai.openai_vision_adapter import zone_evidence

    times = ((day, "10:00"),) if day else ()
    assert zone_evidence(zone, shown, times) is ok


def test_c1_an_offset_never_reaches_a_saved_draft_as_utc_and_dst_rules_still_apply():
    d = _draft(_e(start_date="2027-03-04", end_date="2027-03-04", start_time="10:00", end_time="11:00",
                  all_day=False, time_zone="UTC", date_as_shown="4 March 2027", time_as_shown="10:00-11:00",
                  time_zone_as_shown="UTC+05:30"))
    assert d.time_zone is None and d.start_time is None and "Time zone shown: UTC+05:30." in d.description
    fold = _draft(_e(start_date="2026-10-25", end_date="2026-10-25", start_time="01:30", end_time="02:30",
                     all_day=False, time_zone="Europe/London", date_as_shown="25 October 2026",
                     time_as_shown="01:30-02:30", time_zone_as_shown="London"))
    assert fold.time_zone == "Europe/London" and "start_time" in fold.uncertain_fields


# ======================================================================= D1 (round 3)
def _ny(start, end, offset, day="2026-11-01", **over):
    return _e(title="Late call", start_date=day, end_date=day, start_time=start, end_time=end, all_day=False,
              time_zone="America/New_York", date_as_shown=day, time_as_shown=f"{start}-{end}",
              time_zone_as_shown=f"New York ({offset})" if offset else "New York", **over)


@pytest.mark.parametrize("offset, kept", [("UTC−04:00", True), ("UTC−05:00", False)])
def test_d1_the_offset_is_checked_at_the_event_time_through_the_api(env, offset, kept):
    """2026-11-01 00:30-00:45 in New York is still EDT (UTC-04:00); EST starts at 02:00."""
    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (90, 2, 1) if kept else (91, 2, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    aid, v1 = _prepare_event(c, scripted, sid, _ny("00:30", "00:45", offset))
    content = v1["content"]
    if kept:
        assert (content["time_zone"], content["start_time"], content["end_time"]) == ("America/New_York", "00:30", "00:45")
        assert _try_approve(c, aid, v1).status_code == 201
    else:
        assert content["time_zone"] is None and content["start_time"] is None
        assert "time_zone" in content["missing_fields"]
        r = _try_approve(c, aid, v1)
        assert r.status_code == 409 and r.json()["error"]["code"] == "not_approvable"


def _offset(zone, day, clock, fold=0):
    """Timezone-aware fixture check: the real offset at that local time (minutes)."""
    import zoneinfo
    from datetime import datetime as _dt

    local = _dt.fromisoformat(f"{day}T{clock}").replace(tzinfo=zoneinfo.ZoneInfo(zone), fold=fold)
    return int(local.utcoffset().total_seconds() // 60)


def test_d1_fixtures_are_what_the_tz_database_says():
    assert _offset("America/New_York", "2026-11-01", "00:30") == -240   # EDT, before fall-back
    assert _offset("America/New_York", "2026-11-01", "03:00") == -300   # EST, after fall-back
    assert {_offset("America/New_York", "2026-11-01", "01:30", f) for f in (0, 1)} == {-240, -300}  # repeated
    assert _offset("Europe/London", "2027-07-01", "10:00") == 60


@pytest.mark.parametrize("event, tz_kept, uncertain", [
    # 1. Before fall-back, correct offset.
    (dict(start="00:30", end="00:45", offset="UTC−04:00"), True, set()),
    # 2. Before fall-back, wrong offset.
    (dict(start="00:30", end="00:45", offset="UTC−05:00"), False, set()),
    # 3. After fall-back, matching offset.
    (dict(start="03:00", end="04:00", offset="UTC−05:00"), True, set()),
    (dict(start="03:00", end="04:00", offset="UTC−04:00"), False, set()),
    # 4. Repeated hour: either offset is a valid reading; the time stays uncertain.
    (dict(start="01:30", end="01:45", offset="UTC−04:00"), True, {"start_time", "end_time"}),
    (dict(start="01:30", end="01:45", offset="UTC−05:00"), True, {"start_time", "end_time"}),
    # 6. Crossing the transition: one offset cannot be right for both ends...
    (dict(start="00:30", end="03:00", offset="UTC−04:00"), False, set()),
    # ...both shown: kept, but the user must confirm it.
    (dict(start="00:30", end="03:00", offset="UTC−04:00 to UTC−05:00"), True, {"time_zone"}),
    # 9. An IANA/city zone without an offset needs no offset check.
    (dict(start="00:30", end="00:45", offset=None), True, set()),
])
def test_d1_offsets_are_checked_at_the_local_start_and_end(event, tz_kept, uncertain):
    d = _draft(_ny(event["start"], event["end"], event["offset"]))
    assert (d.time_zone == "America/New_York") is tz_kept
    if tz_kept:
        assert (d.start_time, d.end_time) == (event["start"], event["end"])
        assert uncertain <= set(d.uncertain_fields)
    else:
        assert d.start_time is None and d.end_time is None and "time_zone" in d.missing_fields


def test_d1_spring_forward_nonexistent_start_is_cleared_and_the_end_is_checked():
    # 2027-03-14 02:30 does not exist in New York; 03:30 is EDT (UTC-04:00).
    d = _draft(_ny("02:30", "03:30", "UTC−04:00", day="2027-03-14"))
    assert d.start_time is None and "does not exist in America/New_York" in d.description
    assert d.time_zone == "America/New_York" and d.end_time == "03:30"
    wrong = _draft(_ny("02:30", "03:30", "UTC−05:00", day="2027-03-14"))
    assert wrong.time_zone is None


def test_d1_an_ordinary_date_and_an_explicit_iana_zone():
    summer = _draft(_e(title="x", start_date="2027-07-01", end_date="2027-07-01", start_time="10:00", end_time="11:00",
                       all_day=False, time_zone="Europe/London", date_as_shown="1 July 2027",
                       time_as_shown="10:00-11:00", time_zone_as_shown="Europe/London (UTC+01:00)"))
    assert summer.time_zone == "Europe/London" and summer.uncertain_fields == []
    winter = _draft(_e(title="x", start_date="2027-01-15", end_date="2027-01-15", start_time="10:00", end_time="11:00",
                       all_day=False, time_zone="Europe/London", date_as_shown="15 January 2027",
                       time_as_shown="10:00-11:00", time_zone_as_shown="Europe/London (UTC+01:00)"))
    assert winter.time_zone is None


def test_d1_without_time_evidence_an_offset_cannot_confirm_the_zone():
    d = _draft(_e(title="x", start_date="2026-11-01", end_date="2026-11-01", start_time="00:30", end_time="00:45",
                  all_day=False, time_zone="America/New_York", date_as_shown="2026-11-01",
                  time_zone_as_shown="New York (UTC−04:00)"))
    assert d.start_time is None and d.time_zone is None  # nothing to check the offset against


def test_d1_an_incomplete_draft_is_never_auto_approvable_and_stays_editable(env):
    from tests.test_draft_editing import EVENT_FIELDS

    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (92, 2, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    aid, v1 = _prepare_event(c, scripted, sid, _ny("00:30", "03:00", "UTC−04:00"))  # crossing, one offset
    assert v1["content"]["time_zone"] is None
    assert _try_approve(c, aid, v1).status_code == 409
    edited = {f: v1["content"][f] for f in EVENT_FIELDS} | {
        "start_time": "00:30", "end_time": "03:00", "time_zone": "America/New_York"}
    v2 = c.post(f"/api/event-drafts/{aid}/edits", headers=HDRS,
                json={"baseVersionId": v1["versionId"], "content": edited, "uncertainFields": []})
    assert v2.status_code == 200, v2.text
    assert _try_approve(c, aid, v2.json()).status_code == 201
# ======================================================================= E1 (round 4): Etc/GMT identities
def _fixed(zone, shown, day="2027-03-04"):
    return _e(title="Stand-up", start_date=day, end_date=day, start_time="10:00", end_time="11:00", all_day=False,
              time_zone=zone, date_as_shown="4 March 2027", time_as_shown="10:00-11:00", time_zone_as_shown=shown)
@pytest.mark.parametrize("shown, zone, kept", [
    ("Etc/GMT-5", "Etc/GMT-5", True),    # the reproduction: UTC+05:00 named exactly
    ("Etc/GMT-5", "Etc/GMT+5", False),   # the reproduction: UTC-05:00, ten hours off
])
def test_e1_etc_gmt_identity_through_preparation_and_approval(env, shown, zone, kept):
    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (93, 2, 1) if kept else (94, 2, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    aid, v1 = _prepare_event(c, scripted, sid, _fixed(zone, shown))
    content = v1["content"]
    if kept:
        assert (content["time_zone"], content["start_time"], content["end_time"]) == (zone, "10:00", "11:00")
        assert _try_approve(c, aid, v1).status_code == 201
    else:
        assert content["time_zone"] is None and content["start_time"] is None
        assert "time_zone" in content["missing_fields"]
        r = _try_approve(c, aid, v1)
        assert r.status_code == 409 and r.json()["error"]["code"] == "not_approvable"
def test_e1_fixtures_are_what_the_tz_database_says():
    assert _offset("Etc/GMT-5", "2027-03-04", "10:00") == 300    # POSIX sign: UTC+05:00
    assert _offset("Etc/GMT+5", "2027-03-04", "10:00") == -300   # UTC-05:00
@pytest.mark.parametrize("zone, shown, ok", [
    # A whole IANA identifier is one token, matched by its identity.
    ("Etc/GMT-5", "Etc/GMT-5", True),
    ("Etc/GMT+5", "Etc/GMT-5", False),
    ("Etc/GMT+5", "Etc/GMT+5", True),
    ("Etc/GMT-5", "Etc/GMT+5", False),
    ("Etc/GMT-5", "times in etc/gmt-5", True),         # case-insensitive identifier
    ("Etc/GMT", "Etc/GMT", True),
    ("Etc/UTC", "Etc/UTC", True),
    ("UTC", "Etc/UTC", True),                           # the same zero offset, named
    ("Etc/GMT+5", "Etc/GMT", False),
    ("UTC", "Etc/GMT-5", False),                        # no "GMT-5" pulled out of it
    # Standalone offsets keep working, read with their written sign.
    ("Etc/GMT-5", "UTC+05:00", True),
    ("Etc/GMT+5", "UTC-05:00", True),
    ("Etc/GMT+5", "UTC+05:00", False),
    ("Etc/GMT+5", "GMT-5", True),                       # standalone GMT-5 is UTC-05:00
    ("Etc/GMT-5", "GMT-5", False),
    ("Etc/GMT-5", "GMT+5", True),
    # An identifier plus a standalone offset must agree.
    ("Etc/GMT-5", "Etc/GMT-5 (UTC+05:00)", True),
    ("Etc/GMT-5", "Etc/GMT-5 (UTC-05:00)", False),
    ("Etc/GMT+5", "Etc/GMT-5 (UTC-05:00)", False),      # both readings contradict
    ("Europe/London", "Europe/London (UTC+05:00)", False),
    ("Europe/London", "Europe/London (UTC+00:00)", False),  # BST on 2027-07-01
    ("Europe/London", "Europe/London (UTC+01:00)", True),
    # Regional zones are unchanged.
    ("Asia/Kolkata", "Asia/Kolkata", True),
    ("Asia/Kolkata", "Kolkata (UTC+05:30)", True),
    ("America/New_York", "New York", True),
    ("Europe/Paris", "Europe/London", False),
])
def test_e1_iana_identifiers_are_atomic_and_offsets_stay_standalone(zone, shown, ok):
    from app.ai.openai_vision_adapter import zone_evidence
    assert zone_evidence(zone, shown, (("2027-07-01", "10:00"),)) is ok
def test_e1_contradictory_evidence_is_never_complete_and_stays_editable():
    d = _draft(_fixed("Etc/GMT-5", "Etc/GMT-5 (UTC-05:00)"))
    assert d.time_zone is None and d.start_time is None and d.end_time is None
    assert "time_zone" in d.missing_fields
    ok = _draft(_fixed("Etc/GMT-5", "Etc/GMT-5"))
    assert (ok.time_zone, ok.start_time, ok.end_time) == ("Etc/GMT-5", "10:00", "11:00") and ok.uncertain_fields == []
# ======================================================================= F1 (round 5): whole IANA tokens
@pytest.mark.parametrize("shown, zone, kept", [
    ("Etc/GMT-5:30", "Etc/GMT-5", False),   # the reproduction: a valid prefix of an invalid token
    ("Etc/GMT-5:30", "Etc/GMT+5", False),
    ("Etc/GMT-5", "Etc/GMT-5", True),
    ("Etc/GMT-5", "Etc/GMT+5", False),
])
def test_f1_partial_iana_tokens_through_preparation_and_approval(env, shown, zone, kept):
    make_client, eng, scripted, use = env
    use("openai")
    c = make_client()
    sid = upload(c, (95 + ["Etc/GMT-5:30", "Etc/GMT-5"].index(shown) * 2 + (zone == "Etc/GMT+5"), 3, 1))
    assert grant(c, sid, shown_disclosure(c)).status_code == 200
    aid, v1 = _prepare_event(c, scripted, sid, _fixed(zone, shown))
    content = v1["content"]
    if kept:
        assert (content["time_zone"], content["start_time"], content["end_time"]) == (zone, "10:00", "11:00")
        assert _try_approve(c, aid, v1).status_code == 201
    else:
        assert content["time_zone"] is None and content["start_time"] is None
        assert "time_zone" in content["missing_fields"]
        r = _try_approve(c, aid, v1)
        assert r.status_code == 409 and r.json()["error"]["code"] == "not_approvable"
@pytest.mark.parametrize("zone, shown, ok", [
    ("Etc/GMT-5", "Etc/GMT-5:30", False),
    ("Etc/GMT+5", "Etc/GMT-5:30", False),
    ("Etc/GMT-5", "Etc/GMT-5.5", False),          # same class: an attached numeric suffix
    ("Etc/GMT-5", "Etc/GMT-5,", True),             # ordinary punctuation after a whole token
    ("Etc/GMT-5", "Etc/GMT-5.", True),
    ("Etc/GMT-5", "(Etc/GMT-5).", True),
    ("Etc/GMT-5", "Etc/GMT-5, 10:00", True),
    # The invalid suffix never becomes a standalone offset either.
    ("Etc/GMT-5", "Etc/GMT-5:30 (UTC+05:00)", False),
    ("UTC", "Etc/GMT-5:30", False),
    ("Asia/Kolkata", "Asia/Kolkata:30", False),    # no prefix match for regional zones
    ("Europe/London", "Europe/London:30", False),  # nor a city match through the token
    # Unchanged.
    ("Asia/Kolkata", "Asia/Kolkata", True),
    ("Asia/Kolkata", "Asia/Kolkata, India", True),
    ("Asia/Kolkata", "Kolkata (UTC+05:30)", True),
    ("Etc/GMT-5", "UTC+05:30", False),
    ("Europe/London", "Europe/London (UTC+01:00).", True),
])
def test_f1_iana_tokens_are_whole_lexical_units(zone, shown, ok):
    from app.ai.openai_vision_adapter import zone_evidence
    assert zone_evidence(zone, shown, (("2027-07-01", "10:00"),)) is ok
def test_f1_an_invalid_token_leaves_an_incomplete_editable_draft():
    d = _draft(_fixed("Etc/GMT-5", "Etc/GMT-5:30"))
    assert d.time_zone is None and d.start_time is None and d.end_time is None
    assert "time_zone" in d.missing_fields
