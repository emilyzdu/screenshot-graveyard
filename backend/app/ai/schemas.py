"""Pydantic result schemas for the AI boundary (Task 2.1).

These models are the ONLY shape the rest of the system accepts from any
`AIAdapter` implementation. Every adapter output MUST validate against them
before it may be persisted; a validation failure raises (pydantic
ValidationError) and the calling service marks the operation `failed`/`uncertain`
WITHOUT touching source bytes (Req 13.2, 13.3; INV-4). Later Phase-2 services
(2.5 classification, 2.7 study notes) enforce that persistence gate — this task
only defines the contracts.

Design source: `.kiro/specs/screenshot-graveyard/design.md`
("AIAdapter Protocol and the fake adapter"), Requirements 13.1-13.4, 4.1, 5.1-5.4.
"""

from __future__ import annotations

import zoneinfo
from datetime import date, datetime, time, timezone
from enum import Enum
from functools import lru_cache
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    field_validator,
    model_validator,
)


class Category(str, Enum):
    """The six fixed classification categories (Req 4.1).

    Values are the exact human-readable labels from the requirements glossary;
    using a str-Enum makes "exactly one of six" structurally enforceable — any
    other value fails validation.
    """

    STUDY_KNOWLEDGE = "Study/Knowledge"
    REFERENCE_DOCUMENT = "Reference/Document"
    SHOPPING_INSPIRATION = "Shopping/Inspiration"
    MEMORY_ENTERTAINMENT = "Memory/Entertainment"
    UNKNOWN_NEEDS_REVIEW = "Unknown/Needs Review"
    POTENTIALLY_SENSITIVE = "Potentially Sensitive"


class EpitaphPayload(BaseModel):
    """A short, honest purpose caption produced in the SAME AI call as the
    classification (Req 5.1).

    The schema structurally separates a VISIBLE FACT from an INFERRED INTENT so
    an adapter cannot collapse the two, and carries an `uncertain` flag so an
    un-inferrable purpose is represented rather than fabricated (Req 5.2-5.4).
    The System must never assert the user's original reason as a known fact
    (Req 5.4) — `inferred_intent` is explicitly optional and advisory.
    """

    model_config = ConfigDict(extra="forbid")

    text: str = Field(
        min_length=1,
        description="The short displayed caption (editable later by the user).",
    )
    visible_facts: str = Field(
        default="",
        description="What is literally visible in the screenshot (no inference).",
    )
    inferred_intent: str | None = Field(
        default=None,
        description=(
            "An explicitly tentative guess at why it may have been saved; never "
            "stated as a known fact. None when no intent is inferred."
        ),
    )
    uncertain: bool = Field(
        default=False,
        description="True when the purpose cannot be reasonably inferred (Req 5.3).",
    )


class ClassificationResult(BaseModel):
    """Structured output of `classify_and_epitaph` (Req 4.1, 5.1, 13.2).

    `category` is constrained to the six-value enum; `confidence` is a bounded
    [0.0, 1.0] score; `uncertain` lets the adapter signal low confidence so the
    service can mark the operation `uncertain` rather than forcing success
    (INV-4; the enforcement itself lives in Task 2.5). The Epitaph is embedded
    because it is produced in the same call (Req 5.1).
    """

    model_config = ConfigDict(extra="forbid")

    category: Category
    confidence: float = Field(ge=0.0, le=1.0)
    uncertain: bool = False
    epitaph: EpitaphPayload
    # Batch 6A: the AI's suggested next step, grounded in what the screenshot
    # shows (e.g. a visible event date -> add_calendar). Advisory only; None when
    # nothing fits or the adapter makes no suggestion (the Fake AI never does).
    suggested_action: Literal["make_notes", "add_calendar"] | None = None


# Batch 6A (P2-D): categories for which NO next step may be suggested, by AI or
# rule. Mirrors the frontend rule (nextAction.ts): an unknown classification
# must be checked by the user, and a possibly sensitive one is never pushed
# toward any action.
SUGGESTION_BLOCKED_CATEGORIES = frozenset({"Unknown/Needs Review", "Potentially Sensitive"})
AI_SUGGESTED_ACTIONS = frozenset({"make_notes", "add_calendar"})


def allowed_suggestion(category, uncertain: bool, action) -> str | None:
    """The AI suggestion to keep, or None. Applied when persisting AND reading."""
    cat = category.value if isinstance(category, Category) else category
    if uncertain or action not in AI_SUGGESTED_ACTIONS:
        return None
    if cat not in {c.value for c in Category} or cat in SUGGESTION_BLOCKED_CATEGORIES:
        return None
    return action


class StudyNoteResult(BaseModel):
    """Structured output of `study_note` (Req 6.4, 6.5, 6.7, 13.2).

    Mirrors the required Study_Note sections exactly: Topic, Main concepts,
    Extracted code, Code explanations, Important pitfalls, Uncertain/ambiguous
    content, and References to source Screenshot IDs. Code is carried verbatim
    as strings so indentation/symbols are preserved faithfully (Req 6.5); the
    service layer (Task 2.7) is responsible for actually honoring that fidelity.
    """

    model_config = ConfigDict(extra="forbid")

    topic: str = Field(min_length=1)
    main_concepts: list[str] = Field(default_factory=list)
    extracted_code: list[str] = Field(default_factory=list)
    code_explanations: list[str] = Field(default_factory=list)
    pitfalls: list[str] = Field(default_factory=list)
    uncertain_content: list[str] = Field(default_factory=list)
    references: list[int] = Field(
        default_factory=list,
        description="Source Screenshot IDs this note was generated from (INV-7).",
    )


# ------------------------------------------------------------- event draft (4B)

EVENT_DRAFT_FIELDS: tuple[str, ...] = (
    "title",
    "start_date",
    "start_time",
    "end_date",
    "end_time",
    "all_day",
    "time_zone",
    "location",
    "description",
)
EventDraftField = Literal[
    "title",
    "start_date",
    "start_time",
    "end_date",
    "end_time",
    "all_day",
    "time_zone",
    "location",
    "description",
]

# Strings with strict patterns, not pydantic date/time: lax date parsing would
# accept unix timestamps or datetime strings and silently coerce them.
_ISO_DATE = r"^\d{4}-\d{2}-\d{2}$"
_LOCAL_TIME = r"^([01]\d|2[0-3]):[0-5]\d$"
_NOT_ZONES = frozenset({"Factory", "localtime", "posixrules"})


def local_time_status(day: str, clock: str, zone: str) -> Literal["ok", "nonexistent", "ambiguous"]:
    """Whether a local wall-clock time happens exactly once in ``zone`` on ``day``.

    ``nonexistent``: skipped by a forward transition (e.g. DST spring-forward).
    ``ambiguous``: happens twice (e.g. DST fall-back), so the offset is unknown.
    Nothing is converted or replaced; this only classifies the given time.
    """
    tz = zoneinfo.ZoneInfo(zone)
    naive = datetime.combine(date.fromisoformat(day), time.fromisoformat(clock))
    first, second = naive.replace(tzinfo=tz, fold=0), naive.replace(tzinfo=tz, fold=1)
    # Matching offsets mean there is no transition at this wall time. A UTC
    # conversion is unnecessary and can overflow near the limits of datetime.
    if first.utcoffset() == second.utcoffset():
        return "ok"
    # During a transition, a time that exists round-trips through UTC unchanged.
    exists = any(
        dt.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) == naive for dt in (first, second)
    )
    return "ambiguous" if exists else "nonexistent"


@lru_cache(maxsize=1)
def iana_time_zones() -> frozenset[str]:
    """IANA zone names known to this runtime (system zoneinfo or the pinned tzdata)."""
    return frozenset(zoneinfo.available_timezones()) - _NOT_ZONES


class EventDraftResult(BaseModel):
    """Structured output of `event_draft` (Batch 4B): a calendar event DRAFT.

    Nothing here is a fact about the screenshot unless an adapter says so, and
    nothing is ever defaulted: no "today", no browser time zone, no assumed
    duration. Every unknown core field is ``None`` AND named in
    ``missing_fields``; a present-but-doubtful value is named in
    ``uncertain_fields``. Dates are ISO ``YYYY-MM-DD``; times are local
    wall-clock ``HH:MM`` in ``time_zone`` (an IANA name), never converted.
    ``references`` are the source Screenshot IDs (INV-7).
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str | None = Field(default=None, min_length=1, max_length=200)
    start_date: str | None = Field(default=None, pattern=_ISO_DATE)
    start_time: str | None = Field(default=None, pattern=_LOCAL_TIME)
    end_date: str | None = Field(default=None, pattern=_ISO_DATE)
    end_time: str | None = Field(default=None, pattern=_LOCAL_TIME)
    all_day: StrictBool | None = None
    time_zone: str | None = Field(default=None, min_length=1, max_length=64)
    location: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = Field(default=None, min_length=1, max_length=2000)
    missing_fields: list[EventDraftField] = Field(default_factory=list)
    uncertain_fields: list[EventDraftField] = Field(default_factory=list)
    references: list[StrictInt] = Field(min_length=1)
    # Batch 6A: other events visible in the same screenshot that this draft does
    # NOT cover (short labels, e.g. "Lab meeting · 2026-12-03"). Shown to the
    # user so a multi-event screenshot is never silently reduced to one event.
    other_events: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("other_events")
    @classmethod
    def _short_labels(cls, v: list[str]) -> list[str]:
        if any(not isinstance(x, str) or not x.strip() or len(x) > 200 for x in v):
            raise ValueError("other_events must be short non-empty labels")
        return [x.strip() for x in v]

    @field_validator("start_date", "end_date")
    @classmethod
    def _real_calendar_date(cls, v: str | None) -> str | None:
        if v is not None:
            date.fromisoformat(v)  # rejects 2026-02-30 etc.
        return v

    @field_validator("time_zone")
    @classmethod
    def _iana_zone(cls, v: str | None) -> str | None:
        if v is not None and v not in iana_time_zones():
            raise ValueError("time_zone must be a known IANA time zone")
        return v

    @field_validator("references")
    @classmethod
    def _positive_ids(cls, v: list[int]) -> list[int]:
        if any(i <= 0 for i in v) or len(set(v)) != len(v):
            raise ValueError("references must be distinct positive screenshot ids")
        return v

    @model_validator(mode="after")
    def _honest_and_consistent(self) -> "EventDraftResult":
        missing, uncertain = self.missing_fields, self.uncertain_fields
        if len(set(missing)) != len(missing) or len(set(uncertain)) != len(uncertain):
            raise ValueError("missing_fields and uncertain_fields must not repeat")
        if set(missing) & set(uncertain):
            raise ValueError("a field cannot be both missing and uncertain")
        values = {f: getattr(self, f) for f in EVENT_DRAFT_FIELDS}
        for f in missing:
            if values[f] is not None:
                raise ValueError(f"{f} is listed as missing but has a value")
        for f in uncertain:
            if values[f] is None:
                raise ValueError(f"{f} is listed as uncertain but has no value")
        # Unknown core fields must be declared, never silently left blank.
        timed = self.all_day is not True
        required = ["title", "start_date", "end_date", "all_day"]
        if timed:
            required += ["start_time", "end_time", "time_zone"]
        for f in required:
            if values[f] is None and f not in missing:
                raise ValueError(f"{f} is unknown and must be listed in missing_fields")
        if self.all_day is True and (self.start_time or self.end_time):
            raise ValueError("an all-day event has no start or end time")
        if (self.start_time or self.end_time) and self.time_zone is None:
            raise ValueError("a time needs an explicit time zone")
        if self.start_time and not self.start_date:
            raise ValueError("start_time needs start_date")
        if self.end_time and not self.end_date:
            raise ValueError("end_time needs end_date")
        if self.end_date and not self.start_date:
            raise ValueError("end_date needs start_date")
        # A complete local date + time must happen exactly once in its zone. A
        # skipped time is impossible; a repeated time is only accepted when it is
        # explicitly marked uncertain (its UTC offset is unknown). Never shifted.
        for day, clock, field in (
            (self.start_date, self.start_time, "start_time"),
            (self.end_date, self.end_time, "end_time"),
        ):
            if day and clock and self.time_zone:
                status = local_time_status(day, clock, self.time_zone)
                if status == "nonexistent":
                    raise ValueError(f"{field} does not exist in {self.time_zone} on {day}")
                if status == "ambiguous" and field not in uncertain:
                    raise ValueError(f"{field} is ambiguous in {self.time_zone} on {day} and must be listed in uncertain_fields")
        if self.start_date and self.end_date:
            start, end = date.fromisoformat(self.start_date), date.fromisoformat(self.end_date)
            if end < start:
                raise ValueError("the event cannot end before it starts")
            if end == start and self.start_time and self.end_time and self.end_time <= self.start_time:
                raise ValueError("the event must end after it starts")
        return self
