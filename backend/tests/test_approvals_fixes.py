"""Batch 5B remediation: Codex blockers B1-B3 and the approval/Safe Burial race.

Disposable SQLite only. Interleavings use real, separate database connections
(file SQLite + NullPool), driven by deterministic hooks rather than timing.
"""

from __future__ import annotations

from threading import Thread

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services import approval_service as approval_mod
from app.services.approval_service import ApprovalService
from app.services.event_draft_artifact_service import EventDraftArtifactService
from tests.test_approvals import SAFE_503, approvals, approve, complete_event, status
from tests.test_draft_editing import current_event, edit_event, edit_note, editable, make_note, note_content
from tests.test_preparations_router import (  # noqa: F401  (fixtures)
    HDRS,
    _archive_on_second_connection,
    _hook_lock,
    _workspace_of,
    env,
    file_env,
    upload,
)


# ---------------------------------------------------------------- B1: strict confirmation
@pytest.mark.parametrize("value", [1, 1.0, 0, "true", "True", None, False, [True], {"v": True}])
def test_only_the_json_boolean_true_confirms(env, value):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    r = c.post(f"/api/artifacts/{aid}/approvals", headers=HDRS,
               json={"versionId": vid, "confirmReviewed": value, "acknowledgeUncertain": []})
    assert r.status_code == 422
    assert approvals(eng) == []


def test_confirmation_must_be_present(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    r = c.post(f"/api/artifacts/{aid}/approvals", headers=HDRS, json={"versionId": vid})
    assert r.status_code == 422 and approvals(eng) == []
    assert approve(c, aid, vid).status_code == 201  # the literal true still works


# ---------------------------------------------------------------- B2: coherent status
def test_status_never_pairs_an_old_current_version_with_a_newer_approval(file_env, monkeypatch):
    """A reads the current pointer (v2); B saves v3 and approves it on ANOTHER
    connection; A resumes. A must not report v2 as current next to v3's approval."""
    c, eng, _ = file_env
    sid, aid, v2 = complete_event(c)
    ws = _workspace_of(eng, sid)
    real = ApprovalService._read_view
    fired = {"done": False}

    def read_then_interleave(self, artifact, version_id=None):
        view = real(self, artifact, version_id)
        if version_id is None and not fired["done"]:
            fired["done"] = True
            with Session(eng) as other:  # a second, independent sqlite3 connection
                out = EventDraftArtifactService(other, ws).save_edit(
                    aid, v2["versionId"], editable(v2["content"], location="Moved"), [])
                v3_id = out.version.version_id
            with Session(eng) as other:
                ApprovalService(other, ws).approve(aid, v3_id, [])
        return view

    monkeypatch.setattr(ApprovalService, "_read_view", read_then_interleave)
    r = status(c, aid)
    assert fired["done"]
    body = r.json()
    # The first attempt is discarded; the retry reads fresh rows (not the
    # session's cached artifact) and answers coherently for v3.
    assert r.status_code == 200, body
    approved_ids = {a["versionId"] for a in body["approvals"]}
    assert body["currentVersionNumber"] == 3
    assert body["status"] == "current_approved" and body["currentVersionId"] in approved_ids


def _save_v3(eng, ws, aid, v2, *, approve_it):
    with Session(eng) as other:  # a second, independent sqlite3 connection
        out = EventDraftArtifactService(other, ws).save_edit(
            aid, v2["versionId"], editable(v2["content"], location="Moved"), [])
        v3_id = out.version.version_id
    if approve_it:
        with Session(eng) as other:
            ApprovalService(other, ws).approve(aid, v3_id, [])
    return v3_id


def test_status_rechecks_the_pointer_after_reading_the_ledger(file_env, monkeypatch):
    """v3 is saved (not approved) on another connection AFTER the ledger read:
    the final pointer read sees it, so v2 is never reported as current."""
    c, eng, _ = file_env
    sid, aid, v2 = complete_event(c)
    ws = _workspace_of(eng, sid)
    real = approval_mod.WorkspaceRepository.list_approvals
    fired = {"v3": None}

    def list_then_interleave(self, artifact_id):
        rows = real(self, artifact_id)
        if fired["v3"] is None:
            fired["v3"] = _save_v3(eng, ws, aid, v2, approve_it=False)
        return rows

    monkeypatch.setattr(approval_mod.WorkspaceRepository, "list_approvals", list_then_interleave)
    r = status(c, aid)
    assert r.status_code == 200, r.json()
    assert r.json()["currentVersionId"] == fired["v3"] and r.json()["currentVersionNumber"] == 3


def test_a_ledger_row_newer_than_the_view_is_never_returned(file_env, monkeypatch):
    """Defence in depth: even if both pointer reads agree on v2, a ledger row for
    a newer version means the view is stale; it is discarded and re-read."""
    c, eng, _ = file_env
    sid, aid, v2 = complete_event(c)
    ws = _workspace_of(eng, sid)
    real_list = approval_mod.WorkspaceRepository.list_approvals
    real_ptr = approval_mod.WorkspaceRepository.read_current_version_id
    fired = {"v3": None}
    ptr_calls = {"n": 0}

    def interleave_then_list(self, artifact_id):
        if fired["v3"] is None:
            fired["v3"] = _save_v3(eng, ws, aid, v2, approve_it=True)
        return real_list(self, artifact_id)

    def stale_first_attempt(self, artifact_id):
        ptr_calls["n"] += 1
        return v2["versionId"] if ptr_calls["n"] <= 2 else real_ptr(self, artifact_id)

    monkeypatch.setattr(approval_mod.WorkspaceRepository, "list_approvals", interleave_then_list)
    monkeypatch.setattr(approval_mod.WorkspaceRepository, "read_current_version_id", stale_first_attempt)
    r = status(c, aid)
    body = r.json()
    assert r.status_code == 200, body
    assert ptr_calls["n"] >= 3  # the first attempt was discarded
    assert body["currentVersionId"] == fired["v3"] and body["status"] == "current_approved"


def test_status_is_unavailable_rather_than_contradictory_when_it_keeps_changing(env, monkeypatch):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    calls = {"n": 0}
    real = approval_mod.WorkspaceRepository.read_current_version_id

    def always_moving(self, artifact_id):
        calls["n"] += 1
        return -calls["n"]  # never equal to what was read before

    monkeypatch.setattr(approval_mod.WorkspaceRepository, "read_current_version_id", always_moving)
    r = status(c, aid)
    assert r.status_code == 503 and r.json() == SAFE_503
    monkeypatch.setattr(approval_mod.WorkspaceRepository, "read_current_version_id", real)
    assert status(c, aid).status_code == 200


# ---------------------------------------------------------------- B3: replay and ledger verification
def _approved_note(c):
    sid, aid = make_note(c)
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    assert approve(c, aid, vid).status_code == 201
    return sid, aid, vid


def test_a_tampered_source_row_blocks_status_and_replay(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid, vid = _approved_note(c)
    foreign = upload(make_client(), (77, 77, 77))
    with eng.begin() as conn:
        conn.execute(text("update source_reference set screenshot_id = :f where artifact_id = :a"), {"f": foreign, "a": aid})
    for r in (status(c, aid), approve(c, aid, vid)):
        assert r.status_code == 503 and r.json() == SAFE_503 and str(foreign) not in r.text
    assert len(approvals(eng)) == 1  # nothing added, nothing repaired


@pytest.mark.parametrize("column, value", [
    ("acknowledged_uncertain_json", "[42]"),
    ("acknowledged_uncertain_json", "not json"),
    ("acknowledged_uncertain_json", '["bogus_field"]'),
    ("acknowledged_uncertain_json", '{"a": 1}'),
    ("acknowledged_uncertain_json", '["topic", "topic"]'),
    ("ai_origin_fields_json", "[null]"),
    ("ai_origin_fields_json", '["start_date"]'),  # an event field on a NOTE
])
def test_corrupt_ledger_metadata_is_rejected_on_status_and_replay(env, column, value):
    make_client, eng, _ = env
    c = make_client()
    _, aid, vid = _approved_note(c)
    with eng.begin() as conn:
        conn.execute(text(f"update approval set {column} = :v"), {"v": value})
    for r in (status(c, aid), approve(c, aid, vid)):
        assert r.status_code == 503 and r.json() == SAFE_503
    assert len(approvals(eng)) == 1


def test_an_approval_pointing_at_another_artifacts_version_is_rejected(env):
    make_client, eng, _ = env
    c = make_client()
    _, a1, v1 = _approved_note(c)
    _, a2 = make_note(c, (9, 8, 7))
    with eng.begin() as conn:  # move the record onto artifact 2 while it still names a1's version
        conn.execute(text("update approval set artifact_id = :b"), {"b": a2})
    assert status(c, a2).status_code == 503
    # Replaying a1's version finds the record by version id; it now claims a2.
    r = approve(c, a1, v1)
    assert r.status_code == 503 and r.json() == SAFE_503
    assert len(approvals(eng)) == 1


def test_a_wrong_version_number_on_the_record_is_rejected(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid, vid = _approved_note(c)
    with eng.begin() as conn:
        conn.execute(text("update approval set version_number = 7"))
    assert status(c, aid).status_code == 503
    assert approve(c, aid, vid).status_code == 503


def test_valid_historical_and_archived_approvals_stay_readable_and_replayable(env):
    make_client, eng, _ = env
    c = make_client()
    sid, aid, v2 = complete_event(c)
    first = approve(c, aid, v2["versionId"]).json()["approval"]
    v3 = edit_event(c, aid, v2["versionId"], editable(v2["content"], location="Hall")).json()
    assert status(c, aid).json()["approvals"] == [first]                 # historical
    assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200
    st = status(c, aid).json()
    assert st["approvals"] == [first] and st["status"] == "older_approved"  # archived historical
    again = approve(c, aid, v2["versionId"])
    assert again.status_code == 200 and again.json()["approval"] == first  # the ORIGINAL record
    assert approve(c, aid, v3["versionId"]).status_code == 409             # new approvals still blocked
    assert len(approvals(eng)) == 1


def test_multi_source_note_approvals_verify_against_all_sources(env):
    make_client, eng, _ = env
    c = make_client()
    a, b = upload(c, (1, 1, 1)), upload(c, (2, 2, 2))
    op = c.post("/api/study-notes", headers=HDRS, json={"screenshotIds": [b, a]}).json()
    aid = c.get(f"/api/operations/{op['operationId']}").json()["artifactId"]
    vid = c.get(f"/api/study-notes/{aid}").json()["versionId"]
    first = approve(c, aid, vid)
    assert first.status_code == 201
    assert approve(c, aid, vid).json()["approval"] == first.json()["approval"]
    assert status(c, aid).json()["status"] == "current_approved"


# ---------------------------------------------------------------- approval versus Safe Burial
def test_burial_committed_before_approval_takes_the_lock_rejects_it(file_env, monkeypatch):
    c, eng, _ = file_env
    sid, aid, v2 = complete_event(c)
    ws = _workspace_of(eng, sid)
    _hook_lock(monkeypatch, before=lambda: _archive_on_second_connection(eng, ws, sid))
    r = approve(c, aid, v2["versionId"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "screenshot_archived"
    assert approvals(eng) == []


def test_burial_started_while_approval_holds_the_lock_waits_and_approval_wins(file_env, monkeypatch):
    c, eng, _ = file_env
    sid, aid, v2 = complete_event(c)
    ws = _workspace_of(eng, sid)
    seen: dict[str, object] = {}

    def bury_while_locked():
        t = Thread(target=lambda: _archive_on_second_connection(eng, ws, sid))
        t.start()
        t.join(timeout=0.5)
        seen["blocked"] = t.is_alive()
        seen["thread"] = t

    _hook_lock(monkeypatch, after=bury_while_locked)
    r = approve(c, aid, v2["versionId"])
    seen["thread"].join(timeout=10)
    assert seen["blocked"] is True and not seen["thread"].is_alive()
    assert r.status_code == 201                       # approval serialized BEFORE the burial
    assert approvals(eng) == [(aid, v2["versionId"], 2)]
    st = status(c, aid).json()                        # and stays readable after it
    assert st["status"] == "current_approved"
    assert st["eligibility"]["reasons"][0]["code"] == "screenshot_archived"


def test_the_final_source_check_uses_the_locked_screenshot_read(env, monkeypatch):
    """The eligibility decision must come from the locked, fresh read (FOR UPDATE /
    populate_existing), not a cached or unlocked one."""
    make_client, eng, _ = env
    c = make_client()
    _, aid, v2 = complete_event(c)
    locked_reads: list[int] = []
    real = approval_mod.WorkspaceRepository.get_screenshot_locked

    def spy(self, screenshot_id):
        locked_reads.append(screenshot_id)
        return real(self, screenshot_id)

    monkeypatch.setattr(approval_mod.WorkspaceRepository, "get_screenshot_locked", spy)
    assert approve(c, aid, v2["versionId"]).status_code == 201
    assert locked_reads == current_event(c, aid)["sourceScreenshotIds"]


# ---------------------------------------------------------------- F2: acknowledgements match the approved version
def _ledger_rows(eng):
    with eng.connect() as conn:
        return [tuple(r) for r in conn.execute(text("select * from approval order by id"))]


def _uncertain_note(c, color=(5, 4, 3)):
    """A Note v2 whose Uncertain section is non-empty, approved with its acknowledgement."""
    sid, aid = make_note(c, color)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    r = edit_note(c, aid, v1["versionId"], note_content(v1, uncertain_content=["Is the base case right?"]))
    assert r.status_code == 200, r.text
    v2 = r.json()
    assert approve(c, aid, v2["versionId"], ["uncertain_content"]).status_code == 201
    return sid, aid, v2


def _uncertain_event(c):
    """A Calendar v3 with uncertain location and title, approved with both acknowledgements."""
    sid, aid, v2 = complete_event(c)
    r = edit_event(c, aid, v2["versionId"], editable(v2["content"], location="Library?"), ["location", "title"])
    assert r.status_code == 200, r.text
    v3 = r.json()
    assert approve(c, aid, v3["versionId"], ["location", "title"]).status_code == 201
    return sid, aid, v3


def _assert_corrupt(c, eng, aid, vid, ack):
    before = _ledger_rows(eng)
    for r in (status(c, aid), approve(c, aid, vid, ack)):
        assert r.status_code == 503 and r.json() == SAFE_503
    assert _ledger_rows(eng) == before  # nothing added, repaired or deleted


@pytest.mark.parametrize("stored", [
    "[]",                                  # required acknowledgement removed
    '["topic"]',                           # substituted by another valid Notes field
    '["topic", "uncertain_content"]',      # an extra field
])
def test_notes_acknowledgements_must_equal_the_versions_uncertainty(env, stored):
    make_client, eng, _ = env
    c = make_client()
    _, aid, v2 = _uncertain_note(c)
    with eng.begin() as conn:
        conn.execute(text("update approval set acknowledged_uncertain_json = :v"), {"v": stored})
    _assert_corrupt(c, eng, aid, v2["versionId"], ["uncertain_content"])


def test_notes_without_uncertainty_must_record_no_acknowledgement(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid, vid = _approved_note(c)  # Fake v1 has nothing uncertain
    with eng.begin() as conn:
        conn.execute(text("update approval set acknowledged_uncertain_json = :v"), {"v": '["uncertain_content"]'})
    _assert_corrupt(c, eng, aid, vid, [])


@pytest.mark.parametrize("stored", [
    '["location"]',                         # missing a required uncertain field
    '["description", "location"]',          # substituted by another valid Calendar field
    '["description", "location", "title"]', # an extra field
    "[]",
])
def test_calendar_acknowledgements_must_equal_the_versions_uncertain_fields(env, stored):
    make_client, eng, _ = env
    c = make_client()
    _, aid, v3 = _uncertain_event(c)
    with eng.begin() as conn:
        conn.execute(text("update approval set acknowledged_uncertain_json = :v"), {"v": stored})
    _assert_corrupt(c, eng, aid, v3["versionId"], ["location", "title"])


def test_exact_acknowledgements_read_and_replay(env):
    make_client, eng, _ = env
    c = make_client()
    _, naid, nv2 = _uncertain_note(c)
    _, eaid, ev3 = _uncertain_event(c)
    for aid, vid, ack in ((naid, nv2["versionId"], ["uncertain_content"]), (eaid, ev3["versionId"], ["location", "title"])):
        st = status(c, aid)
        assert st.status_code == 200 and st.json()["status"] == "current_approved"
        assert st.json()["approvals"][0]["acknowledgedUncertain"] == sorted(ack)
        again = approve(c, aid, vid, ack)
        assert again.status_code == 200 and again.json()["approvalResult"] == "existing"
    assert len(approvals(eng)) == 2


def test_historical_acknowledgements_are_checked_against_their_own_version(env):
    """v2's approval acknowledged v2's uncertainty; v3 has none. v2 stays valid,
    including after Safe Burial, because it is judged against v2 itself."""
    make_client, eng, _ = env
    c = make_client()
    sid, aid, v2 = _uncertain_note(c)
    r = edit_note(c, aid, v2["versionId"], note_content(v2, uncertain_content=[]))
    assert r.status_code == 200, r.text
    st = status(c, aid).json()
    assert st["status"] == "older_approved" and st["approvals"][0]["acknowledgedUncertain"] == ["uncertain_content"]
    assert st["eligibility"]["requiredAcknowledgements"] == []
    assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200
    st = status(c, aid)
    assert st.status_code == 200 and st.json()["status"] == "older_approved"
    again = approve(c, aid, v2["versionId"], ["uncertain_content"])
    assert again.status_code == 200 and again.json()["approvalResult"] == "existing"


def test_historical_calendar_acknowledgements_stay_readable(env):
    make_client, eng, _ = env
    c = make_client()
    sid, aid, v3 = _uncertain_event(c)
    r = edit_event(c, aid, v3["versionId"], editable(v3["content"], location="Library"), [])
    assert r.status_code == 200, r.text
    st = status(c, aid).json()
    assert st["status"] == "older_approved" and st["approvals"][0]["acknowledgedUncertain"] == ["location", "title"]
    assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200
    assert status(c, aid).status_code == 200


def test_multi_source_note_with_uncertainty_round_trips(env):
    make_client, eng, _ = env
    c = make_client()
    a, b = upload(c, (11, 1, 1)), upload(c, (12, 2, 2))
    op = c.post("/api/study-notes", headers=HDRS, json={"screenshotIds": [b, a]}).json()
    aid = c.get(f"/api/operations/{op['operationId']}").json()["artifactId"]
    v1 = c.get(f"/api/study-notes/{aid}").json()
    v2 = edit_note(c, aid, v1["versionId"], note_content(v1, uncertain_content=["Which slide is first?"])).json()
    assert approve(c, aid, v2["versionId"], ["uncertain_content"]).status_code == 201
    assert status(c, aid).json()["status"] == "current_approved"
    assert approve(c, aid, v2["versionId"], ["uncertain_content"]).json()["approvalResult"] == "existing"
