"""Validated AI action plans: what the AI proposes to do with ONE screenshot.

The planner is the decision-maker: it reads the screenshot, infers what (if
anything) the user may want done, chooses tools from a bounded server-side
catalog and drafts their arguments. It never performs an action. Everything
here is a PROPOSAL that the backend validates, the user reviews and approves,
and the user separately authorizes before any external write.

Rules carried by these schemas:

* only the catalog's tool slugs exist (``TOOL_SLUGS``); no meta-tools, no
  arbitrary HTTP, no code execution, no destructive tools;
* each action carries exactly the argument block of its tool, validated with
  strict types and bounds; calendar arguments reuse ``EventDraftResult`` (no
  invented dates, times or zones; DST checks);
* destination-identifying values are never taken from the model: the Notion
  parent page is chosen by the user, the connected account by the server;
* a plan explicitly says ``no_action`` for ordinary references and
  ``needs_clarification`` (with a question) when information is missing.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator, model_validator

from app.ai.schemas import EventDraftResult

TOOL_CALENDAR = "GOOGLECALENDAR_CREATE_EVENT"
TOOL_NOTION = "NOTION_CREATE_NOTION_PAGE"
TOOL_GMAIL = "GMAIL_CREATE_EMAIL_DRAFT"
TOOL_SLUGS: tuple[str, ...] = (TOOL_CALENDAR, TOOL_NOTION, TOOL_GMAIL)
ToolSlug = Literal["GOOGLECALENDAR_CREATE_EVENT", "NOTION_CREATE_NOTION_PAGE", "GMAIL_CREATE_EMAIL_DRAFT"]
Decision = Literal["act", "no_action", "needs_clarification"]

# Which argument block each tool carries.
ARGUMENT_BLOCK = {TOOL_CALENDAR: "calendar", TOOL_NOTION: "notion", TOOL_GMAIL: "gmail"}
MAX_ACTIONS = 3

_UUID = r"^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$"
# Deliberately plain: one address, no display name, no list, no header characters.
_EMAIL = r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"


class NotionPageArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    title: str = Field(min_length=1, max_length=200)
    markdown: str = Field(default="", max_length=8000)
    # The parent page is a destination: chosen by the user, never by the model.
    parent_id: str | None = Field(default=None, pattern=_UUID)


class GmailDraftArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    recipient_email: str | None = Field(default=None, max_length=254, pattern=_EMAIL)
    subject: str = Field(default="", max_length=200)
    body: str = Field(default="", max_length=8000)

    @field_validator("recipient_email")
    @classmethod
    def _blank_is_none(cls, v: str | None) -> str | None:
        return v or None


class PlannedAction(BaseModel):
    """One proposed tool call. Exactly the block for ``tool`` is present."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    tool: ToolSlug
    rationale: str = Field(min_length=1, max_length=300)
    confidence: float = Field(ge=0.0, le=1.0)
    calendar: EventDraftResult | None = None
    notion: NotionPageArgs | None = None
    gmail: GmailDraftArgs | None = None

    @model_validator(mode="after")
    def _one_matching_block(self) -> "PlannedAction":
        wanted = ARGUMENT_BLOCK[self.tool]
        for block in ("calendar", "notion", "gmail"):
            present = getattr(self, block) is not None
            if present != (block == wanted):
                raise ValueError(f"{self.tool} needs exactly its {wanted} arguments")
        return self


class PlannerOutput(BaseModel):
    """What a planner adapter returns (validated again by the service)."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    decision: Decision
    rationale: str = Field(min_length=1, max_length=500)
    clarification_question: str | None = Field(default=None, min_length=1, max_length=300)
    actions: list[PlannedAction] = Field(default_factory=list, max_length=MAX_ACTIONS)
    references: list[StrictInt] = Field(min_length=1, max_length=1)

    @model_validator(mode="after")
    def _decision_consistent(self) -> "PlannerOutput":
        if self.decision == "act":
            if not self.actions:
                raise ValueError("an 'act' plan needs at least one action")
            if self.clarification_question is not None:
                raise ValueError("an 'act' plan does not ask a question")
        elif self.decision == "no_action":
            if self.actions or self.clarification_question is not None:
                raise ValueError("a 'no_action' plan has no actions and no question")
        else:  # needs_clarification
            if self.clarification_question is None or self.actions:
                raise ValueError("a clarification asks one question and proposes no action")
        if any(i <= 0 for i in self.references):
            raise ValueError("references must be positive screenshot ids")
        for action in self.actions:
            if action.calendar is not None and action.calendar.references != self.references:
                raise ValueError("calendar arguments must reference the planned screenshot")
            if action.notion is not None and action.notion.parent_id is not None:
                raise ValueError("the planner never chooses a Notion parent page")
        return self


@dataclass(frozen=True)
class PlannerTool:
    """What the planner is told about one available tool (bounded, server-curated)."""

    slug: str
    app: str
    description: str
    connected: bool


@runtime_checkable
class ActionPlanner(Protocol):
    """Optional adapter capability. Adapters without it cannot plan (fail closed)."""

    def plan_actions(self, images: list[tuple[int, bytes, str]], tools: list[PlannerTool]) -> PlannerOutput: ...
