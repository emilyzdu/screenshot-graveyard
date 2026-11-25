"""Batch 5A remediation: Codex blockers 3-6 (backend).

B3 replay requires the original edit's lineage; B4 Notes source consistency;
B5 no response work after commit; B6 corrupt history / unknown provenance.
Rows are tampered with raw SQL on disposable SQLite to model bad stored data.
"""

from __future__ import annotations

import json

import pytest
from sqlalchemy import text

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
from tests.test_preparations_router import HDRS, env, upload  # noqa: F401  (fixtures)

SAFE_503 = {"error": {"code": "service_unavailable", "message": "Service temporarily unavailable"}}


def _three_versions(c, kind):
    """v1 (AI) → v2 (edit on v1) → v3 (edit on v2). Returns (aid, v1, v2, v3, send)."""
    if kind == "event":
        _, aid = make_event(c)
        v1 = current_event(c, aid)
        send = lambda base, title: edit_event(c, aid, base, editable(v1["content"], title=title))  # noqa: E731
    else:
        _, aid = make_note(c)
        v1 = c.get(f"/api/study-notes/{aid}").json()
        send = lambda base, title: edit_note(c, aid, base, note_content(v1, topic=title))  # noqa: E731
    v2 = send(v1["versionId"], "Two").json()
    v3 = send(v2["versionId"], "Three").json()
    assert (v2["editResult"], v3["editResult"]) == ("created", "created")
    return aid, v1, v2, v3, send


def _rewrite(eng, aid, number, mutate):
    with eng.begin() as conn:
        row = conn.execute(
            text("select id, content_json from artifact_version where artifact_id = :a and version_number = :n"),
            {"a": aid, "n": number},
        ).one()
        conn.execute(text("update artifact_version set content_json = :c where id = :i"),
                     {"c": mutate(row.content_json), "i": row.id})


# ---------------------------------------------------------------- B3: replay needs lineage
@pytest.mark.parametrize("kind", ["event", "note"])
def test_a_stale_base_with_content_equal_to_current_is_a_conflict_not_a_replay(env, kind):
    make_client, eng, _ = env
    c = make_client()
    aid, v1, v2, v3, send = _three_versions(c, kind)
    r = send(v1["versionId"], "Three")  # NEW request: base v1, content == v3
    assert r.status_code == 409 and r.json()["error"]["code"] == "version_conflict"
    assert r.json()["error"]["currentVersionNumber"] == 3
    assert [n for n, _ in versions(eng, aid)] == [1, 2, 3]


@pytest.mark.parametrize("kind", ["event", "note"])
def test_a_genuine_retry_of_the_save_that_made_current_is_replayed(env, kind):
    make_client, eng, _ = env
    c = make_client()
    aid, v1, v2, v3, send = _three_versions(c, kind)
    r = send(v2["versionId"], "Three")  # exactly the request that produced v3
    assert r.status_code == 200 and r.json()["editResult"] == "replayed"
    assert r.json()["versionId"] == v3["versionId"]
    assert [n for n, _ in versions(eng, aid)] == [1, 2, 3]
    # A no-op on the current base is "unchanged"; a different edit on a stale base conflicts.
    assert send(v3["versionId"], "Three").json()["editResult"] == "unchanged"
    assert send(v2["versionId"], "Other").status_code == 409


# ---------------------------------------------------------------- B4: Notes source consistency
def _foreign_screenshot(make_client):
    other = make_client()
    return upload(other, (90, 91, 92))


def test_notes_with_a_foreign_payload_reference_are_not_returned_or_editable(env):
    make_client, eng, _ = env
    c = make_client()
    sid, aid = make_note(c)
    foreign = _foreign_screenshot(make_client)
    v1 = c.get(f"/api/study-notes/{aid}").json()

    def swap(raw):
        content = json.loads(raw)
        content["references"] = [foreign]
        return json.dumps(content)

    _rewrite(eng, aid, 1, swap)
    r = c.get(f"/api/study-notes/{aid}")
    assert r.status_code == 503 and r.json() == SAFE_503 and str(foreign) not in r.text
    e = edit_note(c, aid, v1["versionId"], note_content(v1, topic="New"))
    assert e.status_code == 503 and e.json() == SAFE_503
    assert versions(eng, aid) == [(1, "ai_generate")]


def test_notes_whose_source_rows_point_at_a_foreign_screenshot_are_rejected(env):
    make_client, eng, _ = env
    c = make_client()
    sid, aid = make_note(c)
    foreign = _foreign_screenshot(make_client)
    with eng.begin() as conn:
        conn.execute(text("update source_reference set screenshot_id = :f where artifact_id = :a"), {"f": foreign, "a": aid})
    _rewrite(eng, aid, 1, lambda raw: json.dumps({**json.loads(raw), "references": [foreign]}))
    assert c.get(f"/api/study-notes/{aid}").status_code == 503
    v = c.get(f"/api/study-notes/{aid}/versions").json()["versions"][0]
    assert edit_note(c, aid, v["versionId"], {"topic": "x", "main_concepts": [], "extracted_code": [],
                                              "code_explanations": [], "pitfalls": [], "uncertain_content": []}).status_code == 503
    assert versions(eng, aid) == [(1, "ai_generate")]


def test_a_legitimate_multi_source_note_reads_and_edits_with_all_sources(env):
    make_client, eng, _ = env
    c = make_client()
    a, b = upload(c, (1, 1, 1)), upload(c, (2, 2, 2))
    op = c.post("/api/study-notes", headers=HDRS, json={"screenshotIds": [b, a]}).json()
    aid = c.get(f"/api/operations/{op['operationId']}").json()["artifactId"]
    v1 = c.get(f"/api/study-notes/{aid}").json()
    assert v1["sourceScreenshotIds"] == [b, a] and v1["content"]["references"] == [b, a]
    v2 = edit_note(c, aid, v1["versionId"], note_content(v1, topic="Both"))
    assert v2.status_code == 200 and v2.json()["content"]["references"] == [b, a]
    assert v2.json()["sourceScreenshotIds"] == [b, a]


def test_edit_requests_cannot_supply_note_references(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    r = c.post(f"/api/study-notes/{aid}/edits", headers=HDRS,
               json={"baseVersionId": v1["versionId"], "content": {**note_content(v1), "references": [999]}})
    assert r.status_code == 422
    assert versions(eng, aid) == [(1, "ai_generate")]


# ---------------------------------------------------------------- B5: nothing after commit
@pytest.mark.parametrize("kind, target", [
    ("event", "app.services.event_draft_artifact_service.field_origins"),
    ("note", "app.services.study_note_artifact_service.field_origins"),
])
def test_a_response_construction_failure_rolls_the_save_back(env, monkeypatch, kind, target):
    """Response work happens BEFORE commit, so a failure there saves nothing (503 is then true)."""
    make_client, eng, _ = env
    c = make_client()
    if kind == "event":
        _, aid = make_event(c)
        v1 = current_event(c, aid)
        send = lambda: edit_event(c, aid, v1["versionId"], editable(v1["content"], title="Saved?"))  # noqa: E731
    else:
        _, aid = make_note(c)
        v1 = c.get(f"/api/study-notes/{aid}").json()
        send = lambda: edit_note(c, aid, v1["versionId"], note_content(v1, topic="Saved?"))  # noqa: E731

    def boom(*a, **kw):
        raise RuntimeError("response construction failed")

    with monkeypatch.context() as m:
        m.setattr(target, boom)
        r = send()
    assert r.status_code == 503
    assert versions(eng, aid) == [(1, "ai_generate")]  # rolled back: the 503 is the truth
    ok = send()
    assert ok.status_code == 200 and ok.json()["editResult"] == "created"


@pytest.mark.parametrize("kind", ["event", "note"])
def test_a_response_lost_after_commit_is_recovered_by_a_safe_retry(env, kind):
    make_client, eng, _ = env
    c = make_client()
    if kind == "event":
        _, aid = make_event(c)
        v1 = current_event(c, aid)
        send = lambda: edit_event(c, aid, v1["versionId"], editable(v1["content"], title="Once"))  # noqa: E731
    else:
        _, aid = make_note(c)
        v1 = c.get(f"/api/study-notes/{aid}").json()
        send = lambda: edit_note(c, aid, v1["versionId"], note_content(v1, topic="Once"))  # noqa: E731
    send()  # committed; pretend the client never saw the answer
    retry = send()
    assert retry.status_code == 200 and retry.json()["editResult"] == "replayed"
    assert versions(eng, aid) == [(1, "ai_generate"), (2, "manual_edit")]


# ---------------------------------------------------------------- B6: corrupt history
def _edited_once(c, kind):
    if kind == "event":
        _, aid = make_event(c)
        v1 = current_event(c, aid)
        edit_event(c, aid, v1["versionId"], editable(v1["content"], title="Edited"))
        return aid, f"/api/event-drafts/{aid}"
    _, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    edit_note(c, aid, v1["versionId"], note_content(v1, topic="Edited"))
    return aid, f"/api/study-notes/{aid}"


@pytest.mark.parametrize("kind", ["event", "note"])
@pytest.mark.parametrize("corrupt", ["[]", "{}", "not json", '{"topic": 5}'])
def test_a_corrupt_earlier_version_keeps_the_current_one_readable_with_unknown_provenance(env, kind, corrupt):
    make_client, eng, _ = env
    c = make_client()
    aid, url = _edited_once(c, kind)
    _rewrite(eng, aid, 1, lambda raw: corrupt)
    r = c.get(url)
    assert r.status_code == 200, r.text
    assert r.json()["versionNumber"] == 2 and r.json()["fieldOrigins"] is None
    v1_id = c.get(f"{url}/versions").json()["versions"][0]["versionId"]
    assert c.get(url, params={"versionId": v1_id}).status_code == 503  # the corrupt version itself
    assert [n for n, _ in versions(eng, aid)] == [1, 2]  # nothing rewritten


@pytest.mark.parametrize("kind", ["event", "note"])
def test_an_unrecognised_origin_is_unknown_provenance_not_ai(env, kind):
    make_client, eng, _ = env
    c = make_client()
    aid, url = _edited_once(c, kind)
    with eng.begin() as conn:
        conn.execute(text("update artifact_version set origin = 'mystery' where artifact_id = :a and version_number = 1"), {"a": aid})
    r = c.get(url)
    assert r.status_code == 200 and r.json()["fieldOrigins"] is None


@pytest.mark.parametrize("kind", ["event", "note"])
def test_partial_history_is_unknown_provenance(env, kind):
    make_client, eng, _ = env
    c = make_client()
    aid, url = _edited_once(c, kind)
    with eng.begin() as conn:  # an earlier version disappeared (gap in the history)
        conn.execute(text("update artifact_version set version_number = 7 where artifact_id = :a and version_number = 1"), {"a": aid})
    r = c.get(url)
    assert r.status_code == 200 and r.json()["fieldOrigins"] is None


@pytest.mark.parametrize("kind", ["event", "note"])
def test_corrupt_historical_source_references_make_provenance_unknown(env, kind):
    make_client, eng, _ = env
    c = make_client()
    aid, url = _edited_once(c, kind)
    _rewrite(eng, aid, 1, lambda raw: json.dumps({**json.loads(raw), "references": [424242]}))
    r = c.get(url)
    assert r.status_code == 200 and r.json()["fieldOrigins"] is None
    assert "424242" not in r.text
