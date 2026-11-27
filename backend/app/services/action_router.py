"""Action Router (Batch 6B): choose the next step for ONE analyzed screenshot.

A small, deterministic, bounded policy over the STORED analysis (classification
+ Epitaph). It never calls a model, never reads the image and never executes
anything: it returns one of a closed set of decisions, and the only actions it
can name are the two the app can prepare (``make_notes``, ``add_calendar``).
Screenshot text is untrusted. It is only pattern-matched for supporting evidence
(a visible date; enough visible text), never interpreted as instructions.

Decisions:
  * ``auto``           a supported action may be prepared automatically
                       (only when the workspace opted in, and still under consent);
  * ``recommend``      a supported action is recommended; the user decides;
  * ``keep_reference`` nothing to prepare: keep the screenshot and its Epitaph;
  * ``needs_choice``   no step is chosen (blocked category, uncertain or
                       user-edited analysis); the user may still choose one.

Rules (all must hold for ``auto``):
  1. the category and suggestion pass the existing safety policy
     (``allowed_suggestion``: never for Unknown/Needs Review or Potentially
     Sensitive, never for an uncertain classification);
  2. the classification and the Epitaph were written by an AI (not edited by
     the user) and neither is marked uncertain;
  3. the AI itself suggested the action (the category rule alone never
     auto-prepares; the Fake AI never suggests, so Fake mode never auto-prepares);
  4. model-reported confidence is at least ``AUTO_MIN_CONFIDENCE``. Necessary,
     never sufficient;
  5. the visible facts support the action: a visible date for Add to Calendar;
     Study/Knowledge with enough visible text for Make Notes.
The category and the action are separate: a Reference/Document screenshot that
visibly shows a dated event may be routed to Add to Calendar.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from typing import Literal

from app.ai.schemas import SUGGESTION_BLOCKED_CATEGORIES, allowed_suggestion

ACTION_MAKE_NOTES = "make_notes"
ACTION_ADD_CALENDAR = "add_calendar"
ROUTABLE_ACTIONS = (ACTION_ADD_CALENDAR, ACTION_MAKE_NOTES)
AUTO_MIN_CONFIDENCE = 0.8
NOTES_MIN_VISIBLE_WORDS = 8
_AI_ORIGINS = frozenset({"ai_generate", "ai_redo"})

Decision = Literal["auto", "recommend", "keep_reference", "needs_choice"]

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_MONTH = (
    r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
    r"sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
)
_ORD = r"(?:st|nd|rd|th)?"
_YEAR = r"(\d{4})"
# Candidate dates; each is VALIDATED as a real calendar date before it counts.
_ISO = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_NAME_FIRST = re.compile(rf"\b{_MONTH}\.?\s+(\d{{1,2}}){_ORD}\b(?:,?\s+{_YEAR}\b)?", re.IGNORECASE)
_DAY_FIRST = re.compile(rf"\b(\d{{1,2}}){_ORD}\s+(?:of\s+)?{_MONTH}\b\.?(?:,?\s+{_YEAR}\b)?", re.IGNORECASE)
_NUMERIC = re.compile(r"\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b")
# Event-specific wording: a date alone (a receipt, a document date) is not an event.
_EVENT_CUES = re.compile(
    r"\b(meeting|meet-?up|event|appointment|deadline|due|exam|quiz|midterm|final|class|lecture|seminar|"
    r"workshop|conference|webinar|party|concert|show|game|match|tournament|practice|rehearsal|interview|"
    r"session|talk|ceremony|reservation|booking|flight|festival|club|office hours|presentation|"
    r"orientation|celebration|wedding|birthday|dinner|lunch|breakfast|starts?|begins?|rsvp|doors open)\b",
    re.IGNORECASE,
)
# Screenshot text that tries to direct the app is untrusted: never auto-prepare from it.
_INSTRUCTION_CUES = re.compile(
    r"\b(ignore|disregard|override|bypass)\b.{0,40}\b(instructions?|rules?|previous|above|system|prompt)\b"
    r"|\b(system prompt|you are (?:an? )?(?:ai|assistant|model)|as an ai)\b"
    r"|\b(add|put|create|schedule|insert)\b.{0,60}\bto (?:the |my |your )?calendar\b",
    re.IGNORECASE,
)


# Zero-width and formatting characters only. U+2028/U+2029 (line/paragraph
# separators) are whitespace, not invisible: the whitespace pass turns them into
# spaces, so the words they separate stay separate.
_INVISIBLE = re.compile("[\u200b-\u200f\u2060-\u2064\ufeff\u00ad]")
_SPACES = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    """Untrusted screenshot text in one canonical form before ANY check:
    compatibility-folded (full-width letters, ligatures), invisible characters
    removed, and every run of whitespace (line breaks, tabs, Unicode spaces)
    collapsed to one space. Matching sees what a reader would see."""
    folded = unicodedata.normalize("NFKC", text or "")
    return _SPACES.sub(" ", _INVISIBLE.sub("", folded)).strip()


def _valid(year: int | None, month: int, day: int) -> bool:
    if year is not None and not 1900 <= year <= 2100:
        return False
    try:
        # Without a written year, 29 February must be possible (leap year 2000).
        date(year if year is not None else 2000, month, day)
    except ValueError:
        return False
    return True


def valid_dates(text: str) -> list[tuple[int | None, int, int]]:
    """Every written date in ``text`` that is a real calendar date."""
    text = normalize_text(text)
    out: list[tuple[int | None, int, int]] = []
    for m in _ISO.finditer(text):
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if _valid(y, mo, d):
            out.append((y, mo, d))
    for m in _NAME_FIRST.finditer(text):
        mo, d, y = _MONTHS[m.group(1)[:3].lower()], int(m.group(2)), m.group(3)
        if _valid(int(y) if y else None, mo, d):
            out.append((int(y) if y else None, mo, d))
    for m in _DAY_FIRST.finditer(text):
        d, mo, y = int(m.group(1)), _MONTHS[m.group(2)[:3].lower()], m.group(3)
        if _valid(int(y) if y else None, mo, d):
            out.append((int(y) if y else None, mo, d))
    for m in _NUMERIC.finditer(text):
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        # Day/month order is ambiguous; it counts only if a real date either way.
        for mo, d in ((a, b), (b, a)):
            if _valid(y, mo, d):
                out.append((y, mo, d))
                break
    return out


def has_date_evidence(text: str) -> bool:
    return bool(valid_dates(text))


def has_event_evidence(text: str) -> bool:
    """A real calendar date AND event-specific wording, with no instruction-like text."""
    return (
        has_date_evidence(text)
        and _EVENT_CUES.search(normalize_text(text)) is not None
        and not looks_like_instructions(text)
    )


def looks_like_instructions(text: str) -> bool:
    """Text that addresses the model or the app. A conservative tripwire, not a
    prompt-injection detector: it only ever REMOVES automation (the result is a
    recommendation); everything else stays bounded by the category, provenance
    and event-evidence rules and the closed action set."""
    return _INSTRUCTION_CUES.search(normalize_text(text)) is not None


_WORD = re.compile(r"[^\W_]{2,}", re.UNICODE)


@dataclass(frozen=True)
class RouteInput:
    """The stored analysis fields the router may look at, and nothing else."""

    category: str
    confidence: float
    uncertain: bool
    classification_origin: str
    suggested_action: str | None
    visible_facts: str
    epitaph_uncertain: bool
    epitaph_origin: str


@dataclass(frozen=True)
class Route:
    decision: Decision
    action: str | None
    reason_code: str
    reason: str


def route_from_analysis(view) -> Route:
    """Route an ``AnalysisView`` (app.services.analysis_service)."""
    return route(
        RouteInput(
            category=view.category,
            confidence=float(view.confidence),
            uncertain=bool(view.uncertain),
            classification_origin=view.classification_origin,
            suggested_action=view.suggested_action,
            visible_facts=view.visible_facts or "",
            epitaph_uncertain=bool(view.epitaph_uncertain),
            epitaph_origin=view.epitaph_origin,
        )
    )


def visible_word_count(text: str) -> int:
    return len(_WORD.findall(text or ""))


def route(i: RouteInput) -> Route:
    if i.category == "Potentially Sensitive":
        return Route("needs_choice", None, "sensitive",
                     "It may contain sensitive details, so nothing is prepared automatically. "
                     "Choose a step yourself only if you are comfortable.")
    if i.category in SUGGESTION_BLOCKED_CATEGORIES:
        return Route("needs_choice", None, "unknown",
                     "The AI could not tell what this is, so nothing is prepared automatically.")
    if i.uncertain or i.epitaph_uncertain:
        return Route("needs_choice", None, "uncertain",
                     "The AI marked its result uncertain, so it did not choose a next step.")
    if i.classification_origin not in _AI_ORIGINS:
        return Route("needs_choice", None, "user_edited",
                     "You edited the category, so no step is chosen automatically.")
    # The existing safety policy decides whether the AI's suggestion stands at all.
    suggested = allowed_suggestion(i.category, i.uncertain, i.suggested_action)
    if suggested is None:
        if i.category == "Study/Knowledge":
            return Route("recommend", ACTION_MAKE_NOTES, "rule_study",
                         "Study material can usually become notes, but the AI did not suggest it.")
        return Route("keep_reference", None, "no_step",
                     "Nothing to prepare: this looks like something to keep for reference.")
    label = "Add to Calendar" if suggested == ACTION_ADD_CALENDAR else "Make Notes"
    if i.epitaph_origin not in _AI_ORIGINS:
        return Route("recommend", suggested, "user_edited_epitaph",
                     f"The AI suggested {label}, but the Epitaph was edited, so it is not prepared automatically.")
    if i.confidence < AUTO_MIN_CONFIDENCE:
        return Route("recommend", suggested, "low_confidence",
                     f"The AI suggested {label} but reported low confidence.")
    if suggested == ACTION_ADD_CALENDAR:
        if looks_like_instructions(i.visible_facts):
            return Route("recommend", suggested, "instruction_text",
                         "The screenshot contains text that reads like instructions, so nothing is prepared "
                         "automatically. Check it yourself.")
        if not has_date_evidence(i.visible_facts):
            return Route("recommend", suggested, "no_date_evidence",
                         "The AI suggested Add to Calendar, but no valid date was recorded in what it saw.")
        if not has_event_evidence(i.visible_facts):
            return Route("recommend", suggested, "no_event_evidence",
                         "The AI suggested Add to Calendar, but what it saw does not clearly describe an event.")
        return Route("auto", suggested, "calendar_evidence",
                     "The AI suggested Add to Calendar: the screenshot shows an event with a valid date.")
    if i.category != "Study/Knowledge":
        return Route("recommend", suggested, "notes_not_study",
                     "The AI suggested Make Notes, but this is not classified as study material.")
    if visible_word_count(i.visible_facts) < NOTES_MIN_VISIBLE_WORDS:
        return Route("recommend", suggested, "notes_thin",
                     "The AI suggested Make Notes, but it recorded too little visible text to be sure.")
    return Route("auto", suggested, "notes_evidence",
                 "The AI suggested Make Notes for study material with enough visible text.")
