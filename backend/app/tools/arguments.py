"""Server-side argument building and receipt checking for catalog tools.

The arguments sent to an external tool are DERIVED here from an approved plan
version, never taken from the model or the browser as-is:

* only the reviewed fields of the action's argument block are used;
* safety values are forced by the server (Calendar: primary calendar, no
  guest notifications, no Meet link; Gmail: plain text, own mailbox, draft
  only);
* nothing else is added: no image, no screenshot id, no filename, no other
  workspace data. Calendar events carry one opaque marker (a hash of the plan
  and action) in a PRIVATE extended property so a later check can find them;
* every key must belong to the catalog's verified argument set.

Delivery identity (stable across replans and revisions, never derived from
a plan artifact or version id):

* ``scope_key`` = (workspace, screenshot, tool, destination toolkit). The
  connected account id is deliberately NOT part of it: reconnecting the same
  real account mints a new id, and must not reopen an unresolved write;
* ``delivery_key`` = scope + the normalized INTENDED action: Calendar
  schedule (dates, times, all-day, zone), Notion parent page + normalized
  title, Gmail recipient + normalized subject. Cosmetic edits (case,
  punctuation, spacing, description/body wording) keep the same identity.

Receipts: Calendar success needs the returned event to carry OUR delivery
marker. Notion and Gmail return an item id that cannot be matched to the
request; it is recorded as an UNVERIFIED receipt, never as verified proof.
Anything else is an unknown outcome.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import date, timedelta
from typing import Any

from app.ai.action_plan import TOOL_CALENDAR, TOOL_GMAIL, TOOL_NOTION
from app.tools.catalog import CATALOG

DELIVERY_MARKER = "sgDeliveryKey"
_SAFE_ID = re.compile(r"^[A-Za-z0-9_\-:.@]{1,256}$")


class ArgumentError(Exception):
    """The approved action cannot become tool arguments (safe message)."""


class ReceiptError(Exception):
    """The provider's answer does not prove the item exists."""


def _norm_text(value) -> str:
    return re.sub(r"[^0-9a-z]+", " ", str(value or "").casefold()).strip()


def intended_action(action) -> dict[str, Any]:
    """What the write is FOR, without cosmetic detail. Used only for identity."""
    if action.tool == TOOL_CALENDAR:
        c = action.calendar
        return {"all_day": c.all_day, "start_date": c.start_date, "start_time": c.start_time,
                "end_date": c.end_date, "end_time": c.end_time, "time_zone": c.time_zone}
    if action.tool == TOOL_NOTION:
        parent = (action.notion.parent_id or "").replace("-", "").lower()
        return {"parent": parent, "title": _norm_text(action.notion.title)}
    if action.tool == TOOL_GMAIL:
        return {"to": (action.gmail.recipient_email or "").casefold(), "subject": _norm_text(action.gmail.subject)}
    raise ArgumentError("unsupported tool")


def scope_key(workspace_id: int, screenshot_id: int, action) -> str:
    raw = f"screenshot-graveyard:scope:{workspace_id}:{screenshot_id}:{action.tool}:{action.toolkit}"
    return hashlib.sha256(raw.encode()).hexdigest()


def delivery_key(workspace_id: int, screenshot_id: int, action) -> str:
    scope = scope_key(workspace_id, screenshot_id, action)
    body = json.dumps(intended_action(action), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"screenshot-graveyard:delivery:{scope}:{body}".encode()).hexdigest()


def arguments_sha256(arguments: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(arguments, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def action_problems(action) -> list[dict]:
    """What is still missing before this action could run (user-facing, safe)."""
    problems: list[dict] = []
    if action.tool == TOOL_CALENDAR:
        c = action.calendar
        for field, message in (
            ("title", "Add a title."), ("start_date", "Add a start date."),
            ("end_date", "Add an end date."), ("all_day", "Say whether this is an all-day event."),
        ):
            if getattr(c, field) is None:
                problems.append({"field": field, "message": message})
        if c.all_day is not True:
            for field, message in (
                ("start_time", "Add a start time."), ("end_time", "Add an end time."),
                ("time_zone", "Add a time zone."),
            ):
                if getattr(c, field) is None:
                    problems.append({"field": field, "message": message})
    elif action.tool == TOOL_NOTION:
        if action.notion.parent_id is None:
            problems.append({"field": "parent_id", "message": "Choose the Notion page to create this page under."})
    elif action.tool == TOOL_GMAIL:
        if not action.gmail.subject and not action.gmail.body:
            problems.append({"field": "body", "message": "Add a subject or a message."})
    return problems


def build_arguments(action, key: str) -> dict[str, Any]:
    """The exact arguments for ``action.tool``. Raises :class:`ArgumentError`."""
    if action_problems(action):
        raise ArgumentError("this action is incomplete")
    tool = CATALOG.get(action.tool)
    if tool is None:
        raise ArgumentError("unsupported tool")
    if action.tool == TOOL_CALENDAR:
        c = action.calendar
        args: dict[str, Any] = {
            "summary": c.title,
            "calendar_id": "primary",
            "send_updates": "none",
            "create_meeting_room": False,
            "extended_properties": {"private": {DELIVERY_MARKER: key}},
        }
        if c.location:
            args["location"] = c.location
        if c.description:
            args["description"] = c.description
        if c.all_day is True:
            args["start_date"] = c.start_date
            # Google's all-day end date is exclusive; the draft's is the last day.
            args["end_date"] = (date.fromisoformat(c.end_date) + timedelta(days=1)).isoformat()
        else:
            args["start_datetime"] = f"{c.start_date}T{c.start_time}:00"
            args["end_datetime"] = f"{c.end_date}T{c.end_time}:00"
            args["timezone"] = c.time_zone
    elif action.tool == TOOL_NOTION:
        n = action.notion
        args = {"title": n.title, "parent_id": n.parent_id}
        if n.markdown:
            args["markdown"] = n.markdown
    elif action.tool == TOOL_GMAIL:
        g = action.gmail
        args = {"subject": g.subject, "body": g.body, "is_html": False, "user_id": "me"}
        if g.recipient_email:
            args["recipient_email"] = g.recipient_email
    else:  # pragma: no cover - guarded by the catalog lookup
        raise ArgumentError("unsupported tool")
    if not set(args) <= tool.argument_keys:
        raise ArgumentError("argument outside the verified schema")
    return args


def _containers(data: dict[str, Any]) -> list[dict[str, Any]]:
    out = [data]
    for key in ("response_data", "data"):
        inner = data.get(key)
        if isinstance(inner, dict):
            out.append(inner)
            nested = inner.get("response_data") or inner.get("data")
            if isinstance(nested, dict):
                out.append(nested)
    return out


def extract_receipt(slug: str, data: dict[str, Any], key: str) -> tuple[str, str | None, bool]:
    """``(external_id, https_url_or_None, verified)``, or raise :class:`ReceiptError`.

    Calendar: the event must carry exactly our private delivery marker, or the
    answer is not proof (ReceiptError -> unknown). Notion / Gmail: an item id
    is accepted as an UNVERIFIED receipt (``verified=False``).
    """
    for box in reversed(_containers(data)):
        item_id = box.get("id")
        if not isinstance(item_id, str) or not _SAFE_ID.fullmatch(item_id):
            continue
        url = box.get("htmlLink") or box.get("url")
        link = url if isinstance(url, str) and url.startswith("https://") and len(url) <= 1024 else None
        if slug == TOOL_CALENDAR:
            props = box.get("extendedProperties") or box.get("extended_properties")
            private = props.get("private") if isinstance(props, dict) else None
            if not isinstance(private, dict) or private.get(DELIVERY_MARKER) != key:
                raise ReceiptError("the returned event is not correlated with this request")
            return item_id, link, True
        return item_id, link, False
    raise ReceiptError("no item id in the provider answer")
