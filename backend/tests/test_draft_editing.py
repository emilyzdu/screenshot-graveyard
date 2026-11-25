"""Batch 5A: review, edit and version history for Notes and Calendar drafts.

Drafts are created through the real Prepare path (Fake AI), then edited over
HTTP. Every assertion is against persisted rows / real responses.
"""

from __future__ import annotations

import socket
from threading import Barrier, Thread

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.db import models
from tests.test_event_draft_preparation import CALENDAR, NOTES, prepare
from tests.test_preparations_router import HDRS, counts, env, file_env, upload  # noqa: F401  (fixtures)

LA = "America/Los_Angeles"
EVENT_FIELDS = ("title", "start_date", "start_time", "end_date", "end_time", "all_day", "time_zone", "location", "description")


def make_event(c, color=(1, 2, 3)):
    sid = upload(c, color)
    op = c.get(f"/api/operations/{prepare(c, sid, CALENDAR).json()['operationId']}").json()
    return sid, op["artifactId"]


def make_note(c, color=(3, 2, 1)):
    sid = upload(c, color)
    op = c.get(f"/api/operations/{prepare(c, sid, NOTES).json()['operationId']}").json()
    return sid, op["artifactId"]


def current_event(c, aid):
    return c.get(f"/api/event-drafts/{aid}").json()


def editable(content: dict, **over) -> dict:
    out = {f: content[f] for f in EVENT_FIELDS}
    out.update(over)
    return out


def edit_event(c, aid, base, content, uncertain=None):
    body = {"baseVersionId": base, "content": content}
    if uncertain is not None:
        body["uncertainFields"] = uncertain
    return c.post(f"/api/event-drafts/{aid}/edits", headers=HDRS, json=body)


def note_content(note: dict, **over) -> dict:
    out = {k: v for k, v in note["content"].items() if k != "references"}
    out.update(over)
    return out


def edit_note(c, aid, base, content):
    return c.post(f"/api/study-notes/{aid}/edits", headers=HDRS, json={"baseVersionId": base, "content": content})


def versions(eng, aid):
    with Session(eng) as s:
        return [
            (v.version_number, v.origin)
            for v in s.scalars(
                select(models.ArtifactVersion)
                .where(models.ArtifactVersion.artifact_id == aid)
                .order_by(models.ArtifactVersion.version_number)
            )
        ]


# ---------------------------------------------------------------- calendar edits
def test_calendar_edit_creates_version_2_and_keeps_version_1(env):
    make_client, eng, adapter = env
    c = make_client()
    sid, aid = make_event(c)
    v1 = current_event(c, aid)
    calls = (adapter.calls, adapter.event_calls)
    r = edit_event(c, aid, v1["versionId"], editable(
        v1["content"], title="Study group", start_date="2026-12-01", start_time="15:00",
        end_date="2026-12-01", end_time="16:30", all_day=False, time_zone="Europe/London",
    ))
    assert r.status_code == 200, r.text
    v2 = r.json()
    assert (v2["versionNumber"], v2["origin"], v2["editResult"]) == (2, "manual_edit", "created")
    assert v2["sourceScreenshotIds"] == [sid] and v2["content"]["references"] == [sid]
    # Location was never filled in: still unknown, still missing. Nothing defaulted.
    assert v2["content"]["location"] is None and v2["content"]["missing_fields"] == ["location"]
    assert v2["content"]["uncertain_fields"] == []  # the user replaced the uncertain Fake title
    assert versions(eng, aid) == [(1, "ai_generate"), (2, "manual_edit")]
    # Reload: latest is current; version 1 is untouched and still readable.
    assert current_event(c, aid)["versionId"] == v2["versionId"]
    old = c.get(f"/api/event-drafts/{aid}", params={"versionId": v1["versionId"]}).json()
    assert old["content"] == v1["content"] and old["origin"] == "ai_generate"
    listed = c.get(f"/api/event-drafts/{aid}/versions").json()["versions"]
    assert [(v["versionNumber"], v["origin"], v["isCurrent"]) for v in listed] == [
        (1, "ai_generate", False), (2, "manual_edit", True)]
    assert (adapter.calls, adapter.event_calls) == calls  # editing never calls the AI adapter


def test_multiple_calendar_edits_keep_an_ordered_history(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    base = current_event(c, aid)
    for title in ("One", "Two", "Three"):
        r = edit_event(c, aid, base["versionId"], editable(base["content"], title=title))
        assert r.status_code == 200 and r.json()["editResult"] == "created"
        base = r.json()
    assert versions(eng, aid) == [(1, "ai_generate"), (2, "manual_edit"), (3, "manual_edit"), (4, "manual_edit")]
    for number, title in ((2, "One"), (3, "Two"), (4, "Three")):
        vid = c.get(f"/api/event-drafts/{aid}/versions").json()["versions"][number - 1]["versionId"]
        assert c.get(f"/api/event-drafts/{aid}", params={"versionId": vid}).json()["content"]["title"] == title


def test_incomplete_calendar_drafts_can_be_saved_and_stay_needs_details(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    r = edit_event(c, aid, v1["versionId"], editable(v1["content"], title="Dentist", start_date="2026-05-04"))
    assert r.status_code == 200, r.text
    content = r.json()["content"]
    assert content["start_date"] == "2026-05-04" and content["end_date"] is None
    assert content["missing_fields"] == ["start_time", "end_date", "end_time", "all_day", "time_zone", "location"]


def test_all_day_events_do_not_list_times_or_zone_as_missing(env):
    make_client, _, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    r = edit_event(c, aid, v1["versionId"], editable(
        v1["content"], title="Holiday", start_date="2026-12-24", end_date="2026-12-26", all_day=True, location="Home"))
    assert r.status_code == 200, r.text
    assert r.json()["content"]["missing_fields"] == []


def test_blank_strings_are_unknown_not_empty_values(env):
    make_client, _, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    r = edit_event(c, aid, v1["versionId"], editable(v1["content"], title="X", description="   "))
    assert r.status_code == 200
    assert r.json()["content"]["description"] is None and "description" in r.json()["content"]["missing_fields"]


# ---------------------------------------------------------------- validation
@pytest.mark.parametrize("over, field, text", [
    ({"start_date": "2026-02-30"}, "start_date", "day is out of range"),
    ({"start_date": "12/01/2026"}, "start_date", "YYYY-MM-DD"),
    ({"start_date": "2026-12-01", "start_time": "3pm"}, "start_time", "HH:MM"),
    ({"start_date": "2026-12-01", "start_time": "09:00", "time_zone": "Mars/Olympus"}, "time_zone", "IANA"),
    ({"start_date": "2026-12-01", "start_time": "09:00"}, "time_zone", "explicit time zone"),
    ({"start_date": "2026-12-02", "end_date": "2026-12-01"}, None, "end before it starts"),
    ({"all_day": "yes"}, None, "expected format"),
])
def test_invalid_edits_are_rejected_and_create_no_version(env, over, field, text):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    r = edit_event(c, aid, v1["versionId"], editable(v1["content"], **over))
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_content"
    assert text in r.json()["error"]["message"]
    assert r.json()["error"].get("field") == field
    assert versions(eng, aid) == [(1, "ai_generate")]


@pytest.mark.parametrize("bad_body", [
    {"content": {}},                                         # no base version
    {"baseVersionId": 0, "content": {}},
    {"baseVersionId": "1", "content": {}},
])
def test_edit_body_requires_a_base_version(env, bad_body):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    r = c.post(f"/api/event-drafts/{aid}/edits", headers=HDRS, json=bad_body)
    assert r.status_code == 422
    assert versions(eng, aid) == [(1, "ai_generate")]


@pytest.mark.parametrize("smuggled", [
    {"references": [999]}, {"missing_fields": []}, {"uncertain_fields": []}, {"duration_minutes": 60},
])
def test_clients_cannot_supply_references_or_derived_fields(env, smuggled):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    r = edit_event(c, aid, v1["versionId"], {**editable(v1["content"], title="x"), **smuggled})
    assert r.status_code == 400
    assert versions(eng, aid) == [(1, "ai_generate")]


def test_omitting_a_field_is_rejected_rather_than_silently_clearing_it(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    content = editable(v1["content"], title="x")
    del content["description"]
    assert edit_event(c, aid, v1["versionId"], content).status_code == 400
    assert versions(eng, aid) == [(1, "ai_generate")]


# ---------------------------------------------------------------- DST
def test_a_spring_forward_gap_time_is_rejected(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    r = edit_event(c, aid, v1["versionId"], editable(
        v1["content"], title="x", start_date="2026-03-08", start_time="02:30",
        end_date="2026-03-08", end_time="04:00", all_day=False, time_zone=LA))
    assert r.status_code == 400 and r.json()["error"]["field"] == "start_time"
    assert "does not exist" in r.json()["error"]["message"]
    # Marking it uncertain does not make a nonexistent time acceptable.
    r = edit_event(c, aid, v1["versionId"], editable(
        v1["content"], title="x", start_date="2026-03-08", start_time="02:30",
        end_date="2026-03-08", end_time="04:00", all_day=False, time_zone=LA), uncertain=["start_time"])
    assert r.status_code == 400
    assert versions(eng, aid) == [(1, "ai_generate")]


def test_an_ambiguous_fall_back_time_needs_an_explicit_uncertain_flag(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    content = editable(v1["content"], title="x", start_date="2026-11-01", start_time="01:30",
                       end_date="2026-11-01", end_time="03:00", all_day=False, time_zone=LA)
    r = edit_event(c, aid, v1["versionId"], content)
    assert r.status_code == 400 and "ambiguous" in r.json()["error"]["message"]
    assert r.json()["error"]["field"] == "start_time"
    ok = edit_event(c, aid, v1["versionId"], content, uncertain=["start_time"])
    assert ok.status_code == 200, ok.text
    assert ok.json()["content"]["start_time"] == "01:30"  # kept exactly; no offset invented
    assert ok.json()["content"]["uncertain_fields"] == ["start_time"]


def test_valid_cross_day_events_are_accepted(env):
    make_client, _, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    r = edit_event(c, aid, v1["versionId"], editable(
        v1["content"], title="Night shift", start_date="2026-12-31", start_time="22:00",
        end_date="2027-01-01", end_time="06:00", all_day=False, time_zone=LA))
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------- missing / uncertain / provenance
def test_unchanged_fake_fields_keep_their_ai_origin_and_uncertainty(env):
    """Editing the location does not confirm the simulated title or invent a date."""
    make_client, _, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    assert {f: o["origin"] for f, o in v1["fieldOrigins"].items()} == {f: "ai_generate" for f in EVENT_FIELDS}
    r = edit_event(c, aid, v1["versionId"], editable(v1["content"], location="Room 4"))
    v2 = r.json()
    assert v2["content"]["title"] == v1["content"]["title"]
    assert v2["content"]["uncertain_fields"] == ["title"]  # still uncertain: the user did not change it
    assert v2["content"]["start_date"] is None and "start_date" in v2["content"]["missing_fields"]
    origins = v2["fieldOrigins"]
    assert origins["location"] == {"origin": "manual_edit", "versionNumber": 2}
    assert origins["title"] == {"origin": "ai_generate", "versionNumber": 1}
    assert origins["start_date"] == {"origin": "ai_generate", "versionNumber": 1}
    # The user can add uncertainty to an unchanged field, but cannot silently remove it.
    r3 = edit_event(c, aid, v2["versionId"], editable(v2["content"]), uncertain=[])
    assert r3.json()["editResult"] == "unchanged"


def test_users_can_flag_their_own_values_as_uncertain(env):
    make_client, _, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    r = edit_event(c, aid, v1["versionId"], editable(v1["content"], title="Maybe lunch", location="Cafe?"),
                   uncertain=["location"])
    assert r.json()["content"]["uncertain_fields"] == ["location"]


def test_historical_versions_report_provenance_as_of_that_version(env):
    make_client, _, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    v2 = edit_event(c, aid, v1["versionId"], editable(v1["content"], title="Edited")).json()
    v3 = edit_event(c, aid, v2["versionId"], editable(v2["content"], location="Hall")).json()
    assert v3["fieldOrigins"]["title"]["versionNumber"] == 2 and v3["fieldOrigins"]["location"]["versionNumber"] == 3
    old = c.get(f"/api/event-drafts/{aid}", params={"versionId": v2["versionId"]}).json()
    assert old["fieldOrigins"]["location"] == {"origin": "ai_generate", "versionNumber": 1}


# ---------------------------------------------------------------- notes edits
def test_notes_edit_creates_version_2_with_structured_sections_and_provenance(env):
    make_client, eng, adapter = env
    c = make_client()
    sid, aid = make_note(c)
    v1 = c.get(f"/api/study-notes/{aid}").json()
    calls = (adapter.calls, adapter.event_calls)
    r = edit_note(c, aid, v1["versionId"], note_content(
        v1, pitfalls=["Off-by-one"], extracted_code=["def f():\n\treturn 1  \n"]))
    assert r.status_code == 200, r.text
    v2 = r.json()
    assert (v2["versionNumber"], v2["origin"], v2["editResult"]) == (2, "manual_edit", "created")
    assert v2["content"]["extracted_code"] == ["def f():\n\treturn 1  \n"]  # kept exactly
    assert v2["content"]["topic"] == v1["content"]["topic"]
    assert v2["sourceScreenshotIds"] == [sid] and v2["content"]["references"] == [sid]
    assert v2["fieldOrigins"]["pitfalls"] == {"origin": "manual_edit", "versionNumber": 2}
    assert v2["fieldOrigins"]["topic"] == {"origin": "ai_generate", "versionNumber": 1}
    assert c.get(f"/api/study-notes/{aid}", params={"versionId": v1["versionId"]}).json()["content"] == v1["content"]
    assert versions(eng, aid) == [(1, "ai_generate"), (2, "manual_edit")]
    assert (adapter.calls, adapter.event_calls) == calls


def test_notes_and_calendar_drafts_are_edited_independently(env):
    make_client, eng, _ = env
    c = make_client()
    sid = upload(c)
    note_id = c.get(f"/api/operations/{prepare(c, sid, NOTES).json()['operationId']}").json()["artifactId"]
    event_id = c.get(f"/api/operations/{prepare(c, sid, CALENDAR).json()['operationId']}").json()["artifactId"]
    ev = current_event(c, event_id)
    assert edit_event(c, event_id, ev["versionId"], editable(ev["content"], title="T")).status_code == 200
    assert versions(eng, note_id) == [(1, "ai_generate")]
    note = c.get(f"/api/study-notes/{note_id}").json()
    assert edit_note(c, note_id, note["versionId"], note_content(note, topic="N")).status_code == 200
    assert versions(eng, event_id) == [(1, "ai_generate"), (2, "manual_edit")]


# ---------------------------------------------------------------- concurrency and duplicates
@pytest.mark.parametrize("kind", ["event", "note"])
def test_a_stale_edit_conflicts_and_never_overwrites_the_newer_version(env, kind):
    make_client, eng, _ = env
    c = make_client()
    if kind == "event":
        _, aid = make_event(c)
        base = current_event(c, aid)
        first = edit_event(c, aid, base["versionId"], editable(base["content"], title="Tab A"))
        second = edit_event(c, aid, base["versionId"], editable(base["content"], title="Tab B"))
        read = lambda: current_event(c, aid)["content"]["title"]  # noqa: E731
    else:
        _, aid = make_note(c)
        base = c.get(f"/api/study-notes/{aid}").json()
        first = edit_note(c, aid, base["versionId"], note_content(base, topic="Tab A"))
        second = edit_note(c, aid, base["versionId"], note_content(base, topic="Tab B"))
        read = lambda: c.get(f"/api/study-notes/{aid}").json()["content"]["topic"]  # noqa: E731
    assert first.status_code == 200
    assert second.status_code == 409
    err = second.json()["error"]
    assert err["code"] == "version_conflict" and err["currentVersionNumber"] == 2
    assert err["currentVersionId"] == first.json()["versionId"]
    assert read() == "Tab A"
    assert versions(eng, aid) == [(1, "ai_generate"), (2, "manual_edit")]


@pytest.mark.parametrize("kind", ["event", "note"])
def test_repeating_the_same_save_does_not_create_a_second_version(env, kind):
    make_client, eng, _ = env
    c = make_client()
    if kind == "event":
        _, aid = make_event(c)
        base = current_event(c, aid)
        send = lambda: edit_event(c, aid, base["versionId"], editable(base["content"], title="Same"))  # noqa: E731
    else:
        _, aid = make_note(c)
        base = c.get(f"/api/study-notes/{aid}").json()
        send = lambda: edit_note(c, aid, base["versionId"], note_content(base, topic="Same"))  # noqa: E731
    first, again = send(), send()
    assert first.json()["editResult"] == "created"
    assert again.status_code == 200 and again.json()["editResult"] == "replayed"
    assert again.json()["versionId"] == first.json()["versionId"]
    assert versions(eng, aid) == [(1, "ai_generate"), (2, "manual_edit")]


@pytest.mark.parametrize("kind", ["event", "note"])
def test_saving_without_changes_creates_nothing(env, kind):
    make_client, eng, _ = env
    c = make_client()
    if kind == "event":
        _, aid = make_event(c)
        base = current_event(c, aid)
        r = edit_event(c, aid, base["versionId"], editable(base["content"]))
    else:
        _, aid = make_note(c)
        base = c.get(f"/api/study-notes/{aid}").json()
        r = edit_note(c, aid, base["versionId"], note_content(base))
    assert r.status_code == 200 and r.json()["editResult"] == "unchanged"
    assert r.json()["versionId"] == base["versionId"]
    assert versions(eng, aid) == [(1, "ai_generate")]


def test_concurrent_edits_from_the_same_base_on_two_connections(file_env):
    """Real file SQLite + NullPool: two requests race the same base; one wins, one conflicts."""
    c, eng, _ = file_env
    sid, aid = make_event(c)
    base = current_event(c, aid)
    barrier = Barrier(2)
    results: list[tuple[int, str]] = []

    def worker(title: str):
        client = TestClient(c.app)
        client.cookies = c.cookies
        barrier.wait()
        r = edit_event(client, aid, base["versionId"], editable(base["content"], title=title))
        results.append((r.status_code, r.json().get("error", {}).get("code", r.json().get("editResult"))))

    threads = [Thread(target=worker, args=(t,)) for t in ("A", "B")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)
    assert not any(t.is_alive() for t in threads)
    statuses = sorted(results)
    # One creates v2; the other either conflicts or (SQLite contention) is a retryable 503.
    assert statuses[0] == (200, "created")
    assert statuses[1] in {(409, "version_conflict"), (503, "service_unavailable")}
    assert versions(eng, aid) == [(1, "ai_generate"), (2, "manual_edit")]


# ---------------------------------------------------------------- access
def test_cross_workspace_and_wrong_kind_edits_are_404_and_write_nothing(env):
    make_client, eng, _ = env
    owner = make_client()
    sid = upload(owner)
    note_id = owner.get(f"/api/operations/{prepare(owner, sid, NOTES).json()['operationId']}").json()["artifactId"]
    event_id = owner.get(f"/api/operations/{prepare(owner, sid, CALENDAR).json()['operationId']}").json()["artifactId"]
    ev, note = current_event(owner, event_id), owner.get(f"/api/study-notes/{note_id}").json()
    other = make_client()
    assert edit_event(other, event_id, ev["versionId"], editable(ev["content"], title="x")).status_code == 404
    assert edit_note(other, note_id, note["versionId"], note_content(note, topic="x")).status_code == 404
    # Wrong kind through each route.
    assert edit_event(owner, note_id, note["versionId"], editable(ev["content"], title="x")).status_code == 404
    assert edit_note(owner, event_id, ev["versionId"], note_content(note, topic="x")).status_code == 404
    # A base version from another artifact is not accepted.
    assert edit_event(owner, event_id, note["versionId"], editable(ev["content"], title="x")).status_code == 404
    assert versions(eng, note_id) == [(1, "ai_generate")] and versions(eng, event_id) == [(1, "ai_generate")]


def test_edits_require_csrf(env):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    r = c.post(f"/api/event-drafts/{aid}/edits", headers={"Origin": HDRS["Origin"]},
               json={"baseVersionId": v1["versionId"], "content": editable(v1["content"], title="x")})
    assert r.status_code == 403
    assert versions(eng, aid) == [(1, "ai_generate")]


def test_archived_drafts_stay_readable_but_cannot_be_edited(env):
    make_client, eng, _ = env
    c = make_client()
    sid = upload(c)
    note_id = c.get(f"/api/operations/{prepare(c, sid, NOTES).json()['operationId']}").json()["artifactId"]
    event_id = c.get(f"/api/operations/{prepare(c, sid, CALENDAR).json()['operationId']}").json()["artifactId"]
    ev, note = current_event(c, event_id), c.get(f"/api/study-notes/{note_id}").json()
    assert c.post(f"/api/screenshots/{sid}/archive", headers=HDRS).status_code == 200
    for r in (
        edit_event(c, event_id, ev["versionId"], editable(ev["content"], title="x")),
        edit_note(c, note_id, note["versionId"], note_content(note, topic="x")),
    ):
        assert r.status_code == 409 and r.json()["error"]["code"] == "screenshot_archived"
    assert current_event(c, event_id)["versionId"] == ev["versionId"]
    assert versions(eng, note_id) == [(1, "ai_generate")] and versions(eng, event_id) == [(1, "ai_generate")]
    # Resurrection makes them editable again.
    assert c.post(f"/api/screenshots/{sid}/restore", headers=HDRS).status_code == 200
    assert edit_event(c, event_id, ev["versionId"], editable(ev["content"], title="x")).status_code == 200


def test_editing_makes_no_network_connection_and_no_operation(env, monkeypatch):
    make_client, eng, _ = env
    c = make_client()
    _, aid = make_event(c)
    v1 = current_event(c, aid)
    with Session(eng) as s:
        ops_before = s.scalar(select(func.count()).select_from(models.Operation))

    def refuse(self, address, *a, **kw):
        raise AssertionError(f"unexpected network connection to {address}")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    assert edit_event(c, aid, v1["versionId"], editable(v1["content"], title="x")).status_code == 200
    with Session(eng) as s:
        assert s.scalar(select(func.count()).select_from(models.Operation)) == ops_before
    assert counts(eng)["sources"] == 1  # no source reference manufactured
