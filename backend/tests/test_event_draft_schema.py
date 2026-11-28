"""EventDraftResult: strict, honest calendar event draft schema (Batch 4B).

Unknown information must be declared missing, never defaulted; dates, times
and time zones are validated strictly with no lax coercion.
"""

from __future__ import annotations

from datetime import date

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st
from pydantic import ValidationError

from app.ai.fake_adapter import FakeAIAdapter, FakeAIAdapterMode
from app.ai.schemas import EVENT_DRAFT_FIELDS, EventDraftResult, iana_time_zones, local_time_status

PBT = settings(max_examples=200, deadline=None, suppress_health_check=[HealthCheck.too_slow])

ALL_UNKNOWN = ["title", "start_date", "start_time", "end_date", "end_time", "all_day", "time_zone"]


def complete(**over):
    base = dict(
        title="Lecture review",
        start_date="2026-12-01",
        start_time="09:00",
        end_date="2026-12-01",
        end_time="10:30",
        all_day=False,
        time_zone="Europe/London",
        references=[1],
    )
    base.update(over)
    return base


def test_a_fully_known_timed_event_validates_and_round_trips():
    e = EventDraftResult.model_validate(complete(location="Room 2", description="Bring notes"))
    assert e.missing_fields == [] and e.uncertain_fields == []
    assert EventDraftResult.model_validate_json(e.model_dump_json()) == e


def test_an_all_day_event_needs_no_times_or_zone():
    e = EventDraftResult.model_validate(
        complete(all_day=True, start_time=None, end_time=None, time_zone=None)
    )
    assert e.start_time is None and e.time_zone is None


def test_everything_unknown_is_valid_only_when_declared_missing():
    assert EventDraftResult(missing_fields=ALL_UNKNOWN, references=[3]).title is None
    with pytest.raises(ValidationError, match="must be listed in missing_fields"):
        EventDraftResult(references=[3])


@pytest.mark.parametrize("field", ALL_UNKNOWN)
def test_each_unknown_core_field_must_be_declared(field):
    with pytest.raises(ValidationError, match=f"{field} is unknown"):
        EventDraftResult.model_validate(complete(**{field: None}))


@pytest.mark.parametrize(
    "field, value",
    [
        ("start_date", 1764547200),  # unix timestamp: no lax coercion
        ("start_date", "2026-12-01T09:00"),
        ("start_date", "tomorrow"),
        ("start_date", "2026-02-30"),
        ("start_date", "01/12/2026"),
        ("start_time", "9:00"),
        ("start_time", "24:00"),
        ("start_time", "09:00:00"),
        ("start_time", "09:00Z"),
        ("start_time", 900),
        ("time_zone", "Local"),
        ("time_zone", "UTC+2"),
        ("time_zone", "localtime"),
        ("time_zone", "../../etc/passwd"),
        ("time_zone", ""),
        ("all_day", "false"),
        ("all_day", 0),
        ("title", "   "),
    ],
)
def test_malformed_values_are_rejected_not_coerced(field, value):
    with pytest.raises(ValidationError):
        EventDraftResult.model_validate(complete(**{field: value}))


@pytest.mark.parametrize("field", ["start_date", "end_date"])
def test_impossible_calendar_dates_are_rejected_even_without_the_other_end(field):
    other = "end_date" if field == "start_date" else "start_date"
    raw = complete(**{field: "2026-02-30", other: None, "end_time": None, "start_time": None},
                   all_day=True, time_zone=None, missing_fields=[other])
    if field == "end_date":
        raw["missing_fields"] = ["start_date"]
    with pytest.raises(ValidationError):
        EventDraftResult.model_validate(raw)
    # The same draft with a real date is accepted when only the start is known.
    if field == "start_date":
        assert EventDraftResult.model_validate({**raw, "start_date": "2026-02-28"}).end_date is None


@pytest.mark.parametrize(
    "over, message",
    [
        ({"end_date": "2026-11-30"}, "cannot end before it starts"),
        ({"end_time": "09:00"}, "must end after it starts"),
        ({"end_time": "08:00"}, "must end after it starts"),
        ({"time_zone": None, "missing_fields": ["time_zone"]}, "a time needs an explicit time zone"),
        ({"all_day": True}, "an all-day event has no start or end time"),
        ({"start_date": None, "missing_fields": ["start_date"]}, "start_time needs start_date"),
        ({"title": "x", "missing_fields": ["title"]}, "listed as missing but has a value"),
        ({"location": None, "uncertain_fields": ["location"]}, "listed as uncertain but has no value"),
        ({"uncertain_fields": ["title", "title"]}, "must not repeat"),
        ({"missing_fields": ["location"], "uncertain_fields": ["location"]}, "both missing and uncertain"),
    ],
)
def test_inconsistent_drafts_are_rejected(over, message):
    with pytest.raises(ValidationError, match=message):
        EventDraftResult.model_validate(complete(**over))


@pytest.mark.parametrize("refs", [[], [0], [-1], [1, 1], [True], ["1"]])
def test_references_are_distinct_positive_integers(refs):
    with pytest.raises(ValidationError):
        EventDraftResult.model_validate(complete(references=refs))


def test_unknown_keys_are_rejected():
    with pytest.raises(ValidationError):
        EventDraftResult.model_validate(complete(duration_minutes=60))


def test_time_zone_data_is_available_for_validation():
    zones = iana_time_zones()
    assert {"UTC", "Europe/London", "America/New_York", "Asia/Shanghai"} <= zones
    assert "localtime" not in zones and "Factory" not in zones


# ------------------------------------------------------------------- the Fake
def test_fake_event_draft_invents_nothing_and_says_so():
    e = FakeAIAdapter().event_draft([(9, b"\x89PNG", "image/png")])
    assert e.references == [9]
    for f in ("start_date", "start_time", "end_date", "end_time", "all_day", "time_zone", "location"):
        assert getattr(e, f) is None and f in e.missing_fields
    assert e.title == "Simulated event draft (Fake AI)" and e.uncertain_fields == ["title"]
    assert "did not read your screenshot" in e.description
    assert "extracted from" not in e.description.lower()


def test_fake_event_draft_ignores_image_content():
    a = FakeAIAdapter().event_draft([(9, b"meeting 3pm friday", "image/png")])
    b = FakeAIAdapter().event_draft([(9, b"\x00" * 50, "image/png")])
    assert a == b


def test_fake_uncertain_mode_has_no_title_either():
    e = FakeAIAdapter(mode=FakeAIAdapterMode.UNCERTAIN).event_draft([(9, b"", "image/png")])
    assert e.title is None and "title" in e.missing_fields


def test_fake_invalid_mode_does_not_validate():
    raw = FakeAIAdapter(mode=FakeAIAdapterMode.INVALID).event_draft([(9, b"", "image/png")])
    with pytest.raises(ValidationError):
        EventDraftResult.model_validate(raw)


# ----------------------------------------------------------------- property
_dates = st.one_of(st.none(), st.dates(min_value=date(2000, 1, 1), max_value=date(2100, 12, 31)).map(str))
_times = st.one_of(st.none(), st.builds(lambda h, m: f"{h:02d}:{m:02d}", st.integers(0, 23), st.integers(0, 59)))
_zones = st.one_of(st.none(), st.sampled_from(["UTC", "Europe/London", "Asia/Tokyo", "Not/AZone"]))
_text = st.one_of(st.none(), st.text(min_size=0, max_size=12))
_fields = st.lists(st.sampled_from(EVENT_DRAFT_FIELDS), max_size=9, unique=True)


@st.composite
def _drafts(draw, consistent: bool):
    """Raw draft dicts. ``consistent`` derives missing/uncertain from the values
    (most are accepted); otherwise the lists are arbitrary (adversarial)."""
    raw = dict(
        title=draw(_text), start_date=draw(_dates), start_time=draw(_times), end_date=draw(_dates),
        end_time=draw(_times), all_day=draw(st.one_of(st.none(), st.booleans())), time_zone=draw(_zones),
        location=draw(_text), references=[1],
    )
    if consistent:
        unknown = [f for f in EVENT_DRAFT_FIELDS if raw.get(f) is None]
        known = [f for f in EVENT_DRAFT_FIELDS if raw.get(f) is not None]
        raw["missing_fields"] = unknown
        raw["uncertain_fields"] = draw(st.lists(st.sampled_from(known), unique=True)) if known else []
    else:
        raw["missing_fields"] = draw(_fields)
        raw["uncertain_fields"] = draw(_fields)
    return raw


def _assert_invents_nothing(raw: dict) -> bool:
    try:
        e = EventDraftResult.model_validate(raw)
    except ValidationError:
        return False
    values = {f: getattr(e, f) for f in EVENT_DRAFT_FIELDS}
    # Nothing was filled in: every accepted value is exactly what was supplied.
    for f in ("start_date", "start_time", "end_date", "end_time", "all_day", "time_zone"):
        assert values[f] == raw[f]
    # Every unknown core field is declared missing; every declared field is unknown.
    core = ["title", "start_date", "end_date", "all_day"]
    if e.all_day is not True:
        core += ["start_time", "end_time", "time_zone"]
    assert all(f in e.missing_fields for f in core if values[f] is None)
    assert all(values[f] is None for f in e.missing_fields)
    assert all(values[f] is not None for f in e.uncertain_fields)
    if e.start_time or e.end_time:
        assert e.time_zone in iana_time_zones()
    for day, clock, field in ((e.start_date, e.start_time, "start_time"), (e.end_date, e.end_time, "end_time")):
        if day and clock and e.time_zone:
            status = local_time_status(day, clock, e.time_zone)
            assert status != "nonexistent"
            assert status == "ok" or field in e.uncertain_fields
    if e.start_date and e.end_date:
        assert e.end_date >= e.start_date
        if e.end_date == e.start_date and e.start_time and e.end_time:
            assert e.end_time > e.start_time  # an unknown end is not "before" the start
    assert EventDraftResult.model_validate_json(e.model_dump_json()) == e
    return True


@PBT
@given(raw=_drafts(consistent=True))
def test_any_accepted_draft_declares_every_unknown_and_invents_nothing(raw):
    _assert_invents_nothing(raw)


@PBT
@given(raw=_drafts(consistent=False))
def test_arbitrary_missing_and_uncertain_lists_never_slip_through(raw):
    _assert_invents_nothing(raw)


def test_the_consistent_generator_mostly_produces_accepted_drafts():
    """Guards against a vacuous property: a meaningful share must validate."""
    accepted = []

    @settings(max_examples=300, deadline=None, database=None, suppress_health_check=[HealthCheck.too_slow])
    @given(raw=_drafts(consistent=True))
    def probe(raw):
        accepted.append(_assert_invents_nothing(raw))

    probe()
    assert sum(accepted) >= len(accepted) // 10


# ------------------------------------------------ B4: local times must exist in the zone
LA = "America/Los_Angeles"


def la(**over):
    return complete(time_zone=LA, **over)


@pytest.mark.parametrize(
    "over",
    [
        # 2026-03-08 02:00 → 03:00 in Los Angeles: 02:30 never happens.
        dict(start_date="2026-03-08", start_time="02:30", end_date="2026-03-08", end_time="04:00"),
        dict(start_date="2026-03-08", start_time="01:00", end_date="2026-03-08", end_time="02:15"),
        dict(start_date="2026-03-08", start_time="02:00", end_date="2026-03-08", end_time="03:30"),
    ],
)
def test_nonexistent_spring_forward_times_are_rejected(over):
    with pytest.raises(ValidationError, match="does not exist"):
        EventDraftResult.model_validate(la(**over))


def test_nonexistent_time_is_rejected_in_other_zones_too():
    # Europe/London 2026-03-29 01:00 → 02:00.
    with pytest.raises(ValidationError, match="does not exist"):
        EventDraftResult.model_validate(complete(
            start_date="2026-03-29", start_time="01:30", end_date="2026-03-29", end_time="03:00"))


@pytest.mark.parametrize("field, over", [
    # 2026-11-01 02:00 → 01:00 in Los Angeles: 01:30 happens twice.
    ("start_time", dict(start_date="2026-11-01", start_time="01:30", end_date="2026-11-01", end_time="03:00")),
    ("end_time", dict(start_date="2026-11-01", start_time="00:30", end_date="2026-11-01", end_time="01:15")),
])
def test_ambiguous_fall_back_times_require_explicit_uncertainty(field, over):
    with pytest.raises(ValidationError, match="ambiguous"):
        EventDraftResult.model_validate(la(**over))
    accepted = EventDraftResult.model_validate(la(**over, uncertain_fields=[field]))
    assert getattr(accepted, field) == over[field]  # kept exactly; no offset or replacement invented
    assert accepted.model_dump()["time_zone"] == LA


@pytest.mark.parametrize("over", [
    dict(start_date="2026-03-08", start_time="01:59", end_date="2026-03-08", end_time="03:00"),  # around the gap
    dict(start_date="2026-11-01", start_time="02:00", end_date="2026-11-01", end_time="03:00"),  # after fall-back
    dict(start_date="2026-07-04", start_time="09:00", end_date="2026-07-04", end_time="17:00"),
    dict(start_date="2026-12-31", start_time="23:00", end_date="2027-01-01", end_time="01:30"),  # cross-day
    dict(start_date="2026-03-07", start_time="22:00", end_date="2026-03-08", end_time="04:00"),  # spans the gap
])
def test_ordinary_and_cross_day_times_are_accepted_unchanged(over):
    e = EventDraftResult.model_validate(la(**over))
    assert (e.start_date, e.start_time, e.end_date, e.end_time) == (
        over["start_date"], over["start_time"], over["end_date"], over["end_time"])
    assert e.uncertain_fields == []


def test_a_gap_time_is_rejected_even_when_marked_uncertain():
    with pytest.raises(ValidationError, match="does not exist"):
        EventDraftResult.model_validate(la(
            start_date="2026-03-08", start_time="02:30", end_date="2026-03-08", end_time="04:00",
            uncertain_fields=["start_time"]))


def test_fake_dates_and_times_stay_missing():
    e = FakeAIAdapter().event_draft([(1, b"", "image/png")])
    assert (e.start_date, e.start_time, e.end_date, e.end_time, e.time_zone) == (None,) * 5


@pytest.mark.parametrize("day", ["2026-03-08", "2026-11-01"])
def test_every_quarter_hour_on_a_transition_day_is_classified_and_enforced(day):
    """Accepted exactly when the time happens once (or twice and is marked uncertain)."""
    for minutes in range(0, 24 * 60, 15):
        clock = f"{minutes // 60:02d}:{minutes % 60:02d}"
        status = local_time_status(day, clock, LA)
        draft = dict(title="x", start_date=day, start_time=clock, end_date="2026-12-31", end_time="23:00",
                     all_day=False, time_zone=LA, references=[1])
        if status == "nonexistent":
            assert "02:00" <= clock < "03:00" and day == "2026-03-08"
            with pytest.raises(ValidationError):
                EventDraftResult.model_validate(draft)
        elif status == "ambiguous":
            assert "01:00" <= clock < "02:00" and day == "2026-11-01"
            with pytest.raises(ValidationError):
                EventDraftResult.model_validate(draft)
            assert EventDraftResult.model_validate({**draft, "uncertain_fields": ["start_time"]}).start_time == clock
        else:
            assert EventDraftResult.model_validate(draft).start_time == clock


@pytest.mark.parametrize(
    "day, zone, start, end",
    [
        ("0001-01-01", "Asia/Tokyo", "00:10", "01:30"),
        ("9999-12-31", "America/Los_Angeles", "22:00", "23:30"),
    ],
)
def test_calendar_boundary_times_can_be_valid_without_a_representable_utc_datetime(day, zone, start, end):
    result = EventDraftResult.model_validate(complete(
        start_date=day, start_time=start, end_date=day, end_time=end, time_zone=zone,
    ))
    assert (result.start_date, result.start_time, result.end_time, result.time_zone) == (day, start, end, zone)
