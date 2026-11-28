"""The bounded, server-controlled tool catalog.

These are the ONLY external tools the planner can see and the executor can
run. Slugs and argument names were checked against Composio's published
toolkit reference (docs.composio.dev/toolkits/googlecalendar, /notion,
/gmail) and, at runtime, against the provider's own tool schema
(``GET /api/v3.1/tools/{slug}``): a tool whose live schema lacks any argument
we would send, is deprecated, or is tagged destructive is withheld.

Deliberately excluded: Composio meta-tools (``COMPOSIO_*``: search,
multi-execute, workbench, bash, connection management), proxy/HTTP execution,
any read, update, delete or send tool. Gmail is limited to creating a DRAFT;
nothing is ever sent.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.ai.action_plan import TOOL_CALENDAR, TOOL_GMAIL, TOOL_NOTION

TOOLKIT_LABELS: dict[str, str] = {
    "googlecalendar": "Google Calendar",
    "notion": "Notion",
    "gmail": "Gmail",
}


@dataclass(frozen=True)
class CatalogTool:
    slug: str
    toolkit: str
    label: str
    # Curated for the planner (short, accurate, no provider marketing text).
    planner_description: str
    # Every argument name this server may ever send for the tool, forced ones
    # included. Each must exist in the provider's live input schema.
    argument_keys: frozenset[str]
    # Arguments sent on EVERY call. The provider's required arguments must be a
    # subset of these, or the tool is withheld (fail closed).
    always_sent: frozenset[str] = frozenset()


CATALOG: dict[str, CatalogTool] = {
    TOOL_CALENDAR: CatalogTool(
        slug=TOOL_CALENDAR,
        toolkit="googlecalendar",
        label="Create a Google Calendar event",
        planner_description=(
            "Create ONE event on the user's primary Google Calendar from an event, "
            "deadline, appointment or booking shown in the screenshot. No guests are "
            "invited and no notifications are sent."
        ),
        argument_keys=frozenset({
            "summary", "description", "location", "start_datetime", "end_datetime", "timezone",
            "start_date", "end_date", "calendar_id", "send_updates", "create_meeting_room",
            "extended_properties",
        }),
        always_sent=frozenset({"summary", "calendar_id", "send_updates", "create_meeting_room", "extended_properties"}),
    ),
    TOOL_NOTION: CatalogTool(
        slug=TOOL_NOTION,
        toolkit="notion",
        label="Create a Notion page",
        planner_description=(
            "Create ONE Notion page (title plus Markdown body) under a page the user "
            "chooses, for notes, reference material, study content or lists worth keeping."
        ),
        argument_keys=frozenset({"title", "markdown", "parent_id"}),
        always_sent=frozenset({"title", "parent_id"}),
    ),
    TOOL_GMAIL: CatalogTool(
        slug=TOOL_GMAIL,
        toolkit="gmail",
        label="Create a Gmail draft (not sent)",
        planner_description=(
            "Create ONE unsent Gmail draft (subject, plain-text body, optional single "
            "recipient) when the screenshot shows a message the user may want to reply "
            "to or write. The draft is never sent."
        ),
        argument_keys=frozenset({"recipient_email", "subject", "body", "is_html", "user_id"}),
        always_sent=frozenset({"subject", "body", "is_html", "user_id"}),
    ),
}

TOOLKITS: tuple[str, ...] = tuple(dict.fromkeys(t.toolkit for t in CATALOG.values()))

# Tags that disqualify a tool even if its slug is allowlisted.
FORBIDDEN_TAGS = frozenset({"destructiveHint"})


def tool_for(slug: str) -> CatalogTool | None:
    return CATALOG.get(slug)
