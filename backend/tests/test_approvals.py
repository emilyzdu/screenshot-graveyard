"""Batch 5B: version-specific approval and the approval ledger.

Drafts come from the real Prepare path (Fake AI) and are edited over HTTP, so
every approval is of a real persisted version. Rows are tampered with raw SQL
on disposable SQLite only.
"""

from __future__ import annotations

import json
import socket
from threading import Barrier, Thread

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.db import models
from app.db.models import AppendOnlyViolationError
from tests.test_draft_editing import (
    current_event,
    edit_event,
    edit_note,
    editable,
    make_event,
    make_note,
    note_content,
    versions,
)
from tests.test_preparations_router import HDRS, env, file_env, upload  # noqa: F401  (fixtures)

COMPLETE = dict(title="Study group", start_date="2026-12-01", start_time="15:00", end_date="2026-12-01",
                end_time="16:30", all_day=False, time_zone="Europe/London")
SAFE_503 = {"error": {"code": "service_unavailable", "message": "Service temporarily unavailable"}}


def status(c, aid):
    return c.get(f"/api/artifacts/{aid}/approval")


def approve(c, aid, version_id, ack=None, **over):
    body = {"versionId": version_id, "confirmReviewed": True, "acknowledgeUncertain": ack or []}
    body.update(over)
    return c.post(f"/api/artifacts/{aid}/approvals", headers=HDRS, json=body)


def approvals(eng, aid=None):
    with Session(eng) as s:
        q = select(models.Approval).order_by(models.Approval.id)
        if aid is not None:
            q = q.where(models.Approval.artifact_id == aid)
        return [(a.artifact_id, a.artifact_version_id, a.version_number) for a in s.scalars(q)]


def complete_event(c, **over):
    """A Fake calendar draft edited into a complete event (v2)."""
    sid, aid = make_event(c)
    v1 = current_event(c, aid)
    v2 = edit_event(c, aid, v1["versionId"], editable(v1["content"], **{**COMPLETE, **over}))
    assert v2.status_code == 200, v2.text
    return sid, aid, v2.json()


def op_count(eng):
    with Session(eng) as s:
        return s.scalar(select(func.count()).select_from(models.Operation))


# ---------------------------------------------------------------- approve the current version
def test_notes_current_version_approval_creates_one_ledger_record(env):
    make_client, eng, adapter = env
    c = make_client()
    sid, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    before = status(c, aid).json()
    assert before["status"] == "never_approved" and before["eligibility"]["eligible"] is True
    assert before["eligibility"]["requiredAcknowledgements"] == []
    assert before["eligibility"]["aiOriginFields"] == ["main_concepts", "topic"]  # untouched Fake content, named
    calls, ops = (adapter.calls, adapter.event_calls), op_count(eng)
    r = approve(c, aid, v1["versionId"])
    assert r.status_code == 201, r.text
    a = r.json()["approval"]
    assert r.json()["approvalResult"] == "created"
    assert (a["artifactId"], a["versionId"], a["versionNumber"], a["approvedBy"]) == (aid, v1["versionId"], 1, "workspace")
    assert a["aiOriginFields"] == ["main_concepts", "topic"] and a["acknowledgedUncertain"] == []
    assert a["approvedAt"].endswith("+00:00")
    assert approvals(eng) == [(aid, v1["versionId"], 1)]
    # Approval changed nothing else: no new version, no AI call, no operation.
    assert versions(eng, aid) == [(1, "ai_generate")]
    assert c.get(f"/api/study-notes/{aid}").json() == v1
    assert (adapter.calls, adapter.event_calls) == calls and op_count(eng) == ops
    after = status(c, aid).json()
    assert after["status"] == "current_approved" and after["approvals"][0]["approvalId"] == a["approvalId"]


def test_a_complete_calendar_version_can_be_approved(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid, v2 = complete_event(c, location="Library")
    st = status(c, aid).json()
    assert st["eligibility"] == {"eligible": True, "reasons": [], "requiredAcknowledgements": [], "aiOriginFields": ["description"]}
    r = approve(c, aid, v2["versionId"])
    assert r.status_code == 201 and r.json()["approval"]["versionNumber"] == 2
    assert approvals(eng) == [(aid, v2["versionId"], 2)]


def test_an_all_day_event_needs_no_times_or_zone(env):
    make_client, _, _ = env
    c = make_client()
    sid, aid = make_event(c)
    v1 = current_event(c, aid)
    v2 = edit_event(c, aid, v1["versionId"], editable(
        v1["content"], title="Holiday", start_date="2026-12-24", end_date="2026-12-26", all_day=True)).json()
    assert status(c, aid).json()["eligibility"]["eligible"] is True
    assert approve(c, aid, v2["versionId"]).status_code == 201


# ---------------------------------------------------------------- eligibility
def test_an_incomplete_calendar_draft_is_not_approvable_with_field_reasons(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)  # the Fake draft: dates, times, zone all missing
    st = status(c, aid).json()["eligibility"]
    assert st["eligible"] is False
    assert [r["field"] for r in st["reasons"]] == ["start_date", "end_date", "all_day", "start_time", "end_time", "time_zone"]
    r = approve(c, aid, v1["versionId"], ack=["title"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_approvable"
    assert [x["field"] for x in r.json()["error"]["reasons"]] == [x["field"] for x in st["reasons"]]
    assert approvals(eng) == []


def test_a_timed_event_without_a_time_zone_cannot_exist_so_cannot_be_approved(env):
    """The schema already refuses times without a zone; a dated event with unknown times is not approvable."""
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    v2 = edit_event(c, aid, v1["versionId"], editable(
        v1["content"], title="T", start_date="2026-12-01", end_date="2026-12-01", all_day=False)).json()
    reasons = status(c, aid).json()["eligibility"]["reasons"]
    assert [r["field"] for r in reasons] == ["start_time", "end_time", "time_zone"]
    assert approve(c, aid, v2["versionId"]).status_code == 409
    assert approvals(eng) == []


def test_calendar_uncertainty_must_be_acknowledged_and_is_recorded(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    v2 = edit_event(c, aid, v1["versionId"], editable(v1["content"], **COMPLETE, location="Cafe?"),
                    uncertain=["location"]).json()
    assert status(c, aid).json()["eligibility"]["requiredAcknowledgements"] == ["location"]
    for wrong in ([], ["title"], ["location", "title"], ["location", "location"]):
        r = approve(c, aid, v2["versionId"], ack=wrong)
        assert r.status_code == 409 and r.json()["error"]["code"] == "acknowledgement_required"
        assert r.json()["error"]["requiredAcknowledgements"] == ["location"]
    assert approvals(eng) == []
    ok = approve(c, aid, v2["versionId"], ack=["location"])
    assert ok.status_code == 201 and ok.json()["approval"]["acknowledgedUncertain"] == ["location"]
    # Approving does not make the value certain: the version is unchanged.
    assert current_event(c, aid)["content"]["uncertain_fields"] == ["location"]


def test_an_unchanged_uncertain_fake_title_must_be_acknowledged(env):
    make_client, _, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    complete_but_fake_title = {k: v for k, v in COMPLETE.items() if k != "title"}
    v2 = edit_event(c, aid, v1["versionId"], editable(v1["content"], **complete_but_fake_title)).json()
    st = status(c, aid).json()["eligibility"]
    assert st["eligible"] is True and st["requiredAcknowledgements"] == ["title"]
    assert "title" in st["aiOriginFields"]
    assert approve(c, aid, v2["versionId"]).status_code == 409
    assert approve(c, aid, v2["versionId"], ack=["title"]).status_code == 201


def test_notes_with_uncertain_content_require_acknowledgement(env):
    make_client, _, _ = env
    c = make_client()
    _, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    v2 = edit_note(c, aid, v1["versionId"], note_content(v1, uncertain_content=["Line 4 was blurry"])).json()
    assert status(c, aid).json()["eligibility"]["requiredAcknowledgements"] == ["uncertain_content"]
    assert approve(c, aid, v2["versionId"]).status_code == 409
    assert approve(c, aid, v2["versionId"], ack=["uncertain_content"]).status_code == 201


@pytest.mark.parametrize("body", [
    {"versionId": 1},
    {"versionId": 1, "confirmReviewed": False},
    {"versionId": 1, "confirmReviewed": "true"},
    {"versionId": "1", "confirmReviewed": True},
    {"versionId": 0, "confirmReviewed": True},
    {"versionId": 1, "confirmReviewed": True, "acknowledgeUncertain": "title"},
    {"versionId": 1, "confirmReviewed": True, "approvedAt": "2020-01-01"},
    {"versionId": 1, "confirmReviewed": True, "workspaceId": 2},
])
def test_explicit_confirmation_and_a_well_formed_body_are_required(env, body):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    if "versionId" in body and body["versionId"] == 1:
        body = {**body, "versionId": v1["versionId"]}
    r = c.post(f"/api/artifacts/{aid}/approvals", headers=HDRS, json=body)
    assert r.status_code == 422
    assert approvals(eng) == []


def test_approval_requires_csrf(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    r = c.post(f"/api/artifacts/{aid}/approvals", headers={"Origin": HDRS["Origin"]},
               json={"versionId": v1["versionId"], "confirmReviewed": True})
    assert r.status_code == 403 and approvals(eng) == []


# ---------------------------------------------------------------- idempotency and concurrency
def test_repeating_an_approval_returns_the_same_record(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    first = approve(c, aid, vid)
    again = approve(c, aid, vid)
    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["approvalResult"] == "existing"
    assert again.json()["approval"] == first.json()["approval"]
    assert len(approvals(eng)) == 1


def test_simultaneous_approvals_on_two_connections_create_one_record(file_env):
    c, eng, _ = file_env
    _, aid = make_note(c)
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    barrier = Barrier(3)
    results: list[tuple[int, str]] = []

    def worker():
        client = TestClient(c.app)
        client.cookies = c.cookies
        barrier.wait()
        r = approve(client, aid, vid)
        results.append((r.status_code, r.json().get("approvalResult") or r.json()["error"]["code"]))

    threads = [Thread(target=worker) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)
    assert not any(t.is_alive() for t in threads)
    assert [r for r in results if r == (201, "created")] == [(201, "created")]
    assert all(r in {(201, "created"), (200, "existing"), (503, "service_unavailable")} for r in results)
    assert len(approvals(eng)) == 1


def test_approval_racing_an_edit_never_approves_an_unintended_version(file_env):
    """Edit and approve of v1 race on two connections: whichever wins, v2 is never approved."""
    c, eng, _ = file_env
    _, aid, v2 = complete_event(c)
    barrier = Barrier(2)
    out: dict[str, int] = {}

    def do_edit():
        client = TestClient(c.app)
        client.cookies = c.cookies
        barrier.wait()
        out["edit"] = edit_event(client, aid, v2["versionId"], editable(v2["content"], location="Moved")).status_code

    def do_approve():
        client = TestClient(c.app)
        client.cookies = c.cookies
        barrier.wait()
        out["approve"] = approve(client, aid, v2["versionId"]).status_code

    threads = [Thread(target=do_edit), Thread(target=do_approve)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)
    rows = approvals(eng, aid)
    assert all(vid == v2["versionId"] for _, vid, _ in rows)  # only ever the version that was asked for
    if out["approve"] == 201:
        assert rows == [(aid, v2["versionId"], 2)]
    else:
        assert out["approve"] in (409, 503) and rows == []
    if out["edit"] == 200:
        assert status(c, aid).json()["currentVersionNumber"] == 3


# ---------------------------------------------------------------- stale versions and later edits
def test_approving_a_version_that_is_no_longer_current_is_a_conflict(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    v2 = edit_note(c, aid, v1["versionId"], note_content(v1, topic="Newer")).json()
    r = approve(c, aid, v1["versionId"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"
    assert r.json()["error"]["currentVersionId"] == v2["versionId"]
    assert approvals(eng) == []


def test_a_redo_before_approval_makes_the_reviewed_version_stale(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    r = c.post(f"/api/study-notes/{aid}/redo", headers=HDRS, json={"instructions": "shorter"})
    assert r.status_code == 202
    assert c.get(f"/api/operations/{r.json()['operationId']}").json()["status"] == "successful"
    assert versions(eng, aid)[-1] == (2, "ai_redo")
    stale = approve(c, aid, v1["versionId"])
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "version_conflict"
    assert approvals(eng) == []


def test_an_edit_after_approval_creates_an_unapproved_version_and_keeps_the_old_approval(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid, v2 = complete_event(c)
    a2 = approve(c, aid, v2["versionId"]).json()["approval"]
    v3 = edit_event(c, aid, v2["versionId"], editable(v2["content"], location="Hall")).json()
    st = status(c, aid).json()
    assert (st["status"], st["currentVersionNumber"]) == ("older_approved", 3)
    assert [(a["versionNumber"], a["approvalId"]) for a in st["approvals"]] == [(2, a2["approvalId"])]
    assert st["eligibility"]["eligible"] is True  # v3 itself still needs its own approval
    # v2's content is untouched and still readable; the ledger is not rewritten.
    assert c.get(f"/api/event-drafts/{aid}", params={"versionId": v2["versionId"]}).json()["content"] == v2["content"]
    # A late retry of the v2 approval returns the existing record; it never approves v3.
    late = approve(c, aid, v2["versionId"])
    assert late.status_code == 200 and late.json()["approvalResult"] == "existing"
    assert approvals(eng, aid) == [(aid, v2["versionId"], 2)]
    # v3 is approved only by its own explicit request.
    assert approve(c, aid, v3["versionId"]).status_code == 201
    assert status(c, aid).json()["status"] == "current_approved"
    assert [a[2] for a in approvals(eng, aid)] == [2, 3]


def test_status_is_restored_from_the_database_after_a_reload(env):
    make_client, _, _ = env
    c = make_client()
    _, aid = make_note(c)
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    approved = approve(c, aid, vid).json()["approval"]
    fresh = make_client()
    fresh.cookies = c.cookies  # same workspace, new app instance
    st = status(fresh, aid).json()
    assert st["status"] == "current_approved" and st["approvals"] == [approved]


# ---------------------------------------------------------------- access, kind and consistency
def test_other_workspaces_cannot_read_or_approve(env):
    make_client, eng, _ = env
    owner = make_client()
    _, aid = make_note(owner)
    vid = owner.get(f"/api/study-notes/{aid}").json()["versionId"]
    other = make_client()
    assert status(other, aid).status_code == 404
    assert approve(other, aid, vid).status_code == 404
    assert approvals(eng) == []


def test_wrong_artifact_version_pairs_and_kinds_are_404(env):
    make_client, eng, _ = env
    c = make_client()
    sid = upload(c)
    from tests.test_event_draft_preparation import CALENDAR, NOTES, prepare
    note_id = c.get(f"/api/operations/{prepare(c, sid, NOTES).json()['operationId']}").json()["artifactId"]
    event_id = c.get(f"/api/operations/{prepare(c, sid, CALENDAR).json()['operationId']}").json()["artifactId"]
    note_vid = c.get(f"/api/study-notes/{note_id}").json()["versionId"]
    assert approve(c, event_id, note_vid).status_code == 404  # version of another artifact
    assert approve(c, note_id, 999_999).status_code == 404
    assert c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).status_code == 202
    with Session(eng) as s:
        cls = s.scalars(select(models.Artifact).where(models.Artifact.kind == "classification")).first()
        cls_vid = cls.current_version_id
    assert status(c, cls.id).status_code == 404
    assert approve(c, cls.id, cls_vid).status_code == 404
    for bad in (0, -1, 999_999):
        assert status(c, bad).status_code == 404
    assert approvals(eng) == []


def test_tampered_source_references_block_status_and_approval(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    with eng.begin() as conn:
        row = conn.execute(text("select content_json from artifact_version where id = :v"), {"v": vid}).one()
        tampered = {**json.loads(row.content_json), "references": [424242]}
        conn.execute(text("update artifact_version set content_json = :c where id = :v"), {"c": json.dumps(tampered), "v": vid})
    for r in (status(c, aid), approve(c, aid, vid)):
        assert r.status_code == 503 and r.json() == SAFE_503 and "424242" not in r.text
    assert approvals(eng) == []


def test_unverifiable_history_is_not_approvable(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    v2 = edit_note(c, aid, v1["versionId"], note_content(v1, topic="Edited")).json()
    with eng.begin() as conn:
        conn.execute(text("update artifact_version set content_json = '[]' where id = :v"), {"v": v1["versionId"]})
    st = status(c, aid).json()["eligibility"]
    assert st["eligible"] is False and st["reasons"][0]["code"] == "history_unverified"
    assert approve(c, aid, v2["versionId"]).status_code == 409
    assert approvals(eng) == []


def test_an_approval_whose_version_bytes_changed_is_reported_unavailable(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    assert approve(c, aid, vid).status_code == 201
    with eng.begin() as conn:  # the approved bytes no longer match the ledger's hash
        row = conn.execute(text("select content_json from artifact_version where id = :v"), {"v": vid}).one()
        conn.execute(text("update artifact_version set content_json = :c where id = :v"),
                     {"c": row.content_json.replace("Synthetic", "Altered"), "v": vid})
    assert status(c, aid).status_code == 503
    assert approve(c, aid, vid).status_code == 503


def test_archived_sources_block_new_approvals_but_keep_existing_ones_readable(env):
    make_client, eng, _ = env
    c = make_client()
    sid, aid, v2 = complete_event(c)
    a2 = approve(c, aid, v2["versionId"]).json()["approval"]
    v3 = edit_event(c, aid, v2["versionId"], editable(v2["content"], location="Hall")).json()
    assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200
    st = status(c, aid).json()
    assert st["approvals"] == [a2] and st["status"] == "older_approved"
    assert st["eligibility"]["eligible"] is False and st["eligibility"]["reasons"][0]["code"] == "screenshot_archived"
    r = approve(c, aid, v3["versionId"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "screenshot_archived"
    assert len(approvals(eng)) == 1
    assert c.post(f"/api/screenshots/{sid}/restore", headers=HDRS).status_code == 200
    assert approve(c, aid, v3["versionId"]).status_code == 201


def test_a_failure_before_commit_saves_nothing(env, monkeypatch):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    from app.services import approval_service

    real = approval_service.ApprovalService._record
    calls = {"n": 0}

    def boom(self, row, artifact):
        calls["n"] += 1
        raise RuntimeError("response construction failed")

    monkeypatch.setattr(approval_service.ApprovalService, "_record", boom)
    r = approve(c, aid, vid)
    assert r.status_code == 503 and calls["n"] == 1
    monkeypatch.setattr(approval_service.ApprovalService, "_record", real)
    assert approvals(eng) == []  # rolled back: the 503 is the truth
    assert approve(c, aid, vid).status_code == 201


def test_ledger_rows_cannot_be_updated_or_deleted_through_the_orm(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    approve(c, aid, c.get(f"/api/study-notes/{aid}").json()["versionId"])
    with Session(eng) as s:
        row = s.scalars(select(models.Approval)).one()
        row.version_number = 99
        with pytest.raises(AppendOnlyViolationError):
            s.flush()
        s.rollback()
        s.delete(s.scalars(select(models.Approval)).one())
        with pytest.raises(AppendOnlyViolationError):
            s.flush()


def test_approval_makes_no_network_connection(env, monkeypatch):
    make_client, eng, adapter = env
    c = make_client()
    _, aid, v2 = complete_event(c)

    def refuse(self, address, *a, **kw):
        raise AssertionError(f"unexpected network connection to {address}")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    calls = (adapter.calls, adapter.event_calls)
    assert approve(c, aid, v2["versionId"]).status_code == 201
    assert status(c, aid).status_code == 200
    assert (adapter.calls, adapter.event_calls) == calls


def test_no_delivery_or_external_route_was_added(env):
    make_client, _, _ = env
    c = make_client()
    paths = c.get("/openapi.json").json()["paths"]
    assert {p: sorted(paths[p]) for p in paths if "approv" in p} == {
        "/api/artifacts/{artifact_id}/approval": ["get"],
        "/api/artifacts/{artifact_id}/approvals": ["post"],
    }
    assert not [p for p in paths if any(k in p.lower() for k in ("deliver", "calendar", "oauth", "onenote", "send"))]
