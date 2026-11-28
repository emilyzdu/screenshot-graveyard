"""AI action plans for ONE screenshot: planning, versioned review and revisions.

Planning (``run_planning``) follows the reviewed draft-worker pattern step by
step and adds the tool context:

  pending + kind -> consent -> catalog discovery (read-only tool schemas)
  -> read the original -> consent-dispatch authorization (Batch 6A)
  -> ONE planner call -> strict validation -> server-side enrichment
     (pinned toolkit version, the destination account from server state)
  -> atomic persistence of an ``action_plan`` artifact + version 1 + source
     reference + operation status.

The planning stage performs NO external mutation: the only provider calls are
``GET`` tool-schema reads. The model only ever sees the bounded catalog and
cannot name an account, a Notion parent page or any tool outside it.

A plan is an append-only versioned artifact like every draft: a revision
(user edits, or re-binding to the current connection) appends a
``manual_edit`` version; nothing is updated in place. Approval uses the
existing approval ledger (exact version + content SHA-256). Execution is a
separate, explicitly authorized step (``tool_execution_service``).
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, ValidationError, model_validator
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import config
from app.ai.action_plan import (
    ARGUMENT_BLOCK,
    MAX_ACTIONS,
    TOOL_CALENDAR,
    ActionPlanner,
    Decision,
    GmailDraftArgs,
    NotionPageArgs,
    PlannedAction,
    PlannerOutput,
    PlannerTool,
    ToolSlug,
)
from app.ai.adapter import AIAdapter, adapter_failure_detail
from app.ai.schemas import EVENT_DRAFT_FIELDS, EventDraftResult
from app.db.repository import CrossWorkspaceError, WorkspaceRepository
from app.db.tool_repository import ToolRepository
from app.services.ai_dispatch_service import AIDispatchService, DispatchDeniedError, DispatchSupersededError
from app.services.artifact_version_service import ORIGIN_MANUAL_EDIT, ArtifactVersionService, VersionConflictError
from app.services.consent_service import (
    ConsentRequiredError,
    ConsentService,
    ConsentServiceUnavailableError,
    ScreenshotNotFoundError as ConsentScreenshotNotFoundError,
)
from app.services.draft_versioning import (
    DraftSourceArchivedError,
    DraftSourceMissingError,
    DraftVersionConflictError,
    field_origins,
    require_sources_active,
)
from app.services.event_draft_artifact_service import (
    EventDraftArtifactService,
    EventDraftEditContent,
    EventDraftEditValidationError,
)
from app.services.operation_service import (
    OperationPersistenceError,
    OperationService,
    OperationState,
    OperationTransitionError,
)
from app.services.preparation_service import key_prefix as preparation_key_prefix
from app.services.vault_service import ScreenshotNotFoundError as VaultScreenshotNotFoundError
from app.services.vault_service import VaultService, VaultServiceError
from app.tools.arguments import action_problems
from app.tools.catalog import CATALOG, FORBIDDEN_TAGS, TOOLKIT_LABELS
from app.tools.provider import get_tool_transport
from app.tools.transport import ToolTransport, ToolTransportError

KIND_ACTION_PLAN = "action_plan"
ACTION_PLAN_ACTION = "plan_actions"  # the preparation-key action segment
_ORIGIN_AI_GENERATE = "ai_generate"
PLAN_FIELDS: tuple[str, ...] = tuple(f"a{i}" for i in range(MAX_ACTIONS))
ACK_FIELDS: frozenset[str] = frozenset(f"a{i}.{f}" for i in range(MAX_ACTIONS) for f in EVENT_DRAFT_FIELDS)


# ------------------------------------------------------------ stored content
class Destination(BaseModel):
    """The connected account an action is bound to. Set by the server only."""

    model_config = ConfigDict(extra="forbid")

    connection_id: StrictInt = Field(gt=0)
    connected_account_id: str = Field(min_length=1, max_length=128)
    mode: Literal["fake", "composio"]


class StoredAction(PlannedAction):
    index: StrictInt = Field(ge=0, lt=MAX_ACTIONS)
    toolkit: str
    toolkit_version: str = Field(min_length=1, max_length=64)
    enabled: StrictBool = True
    destination: Destination | None = None

    @model_validator(mode="after")
    def _toolkit_matches(self) -> "StoredAction":
        if CATALOG[self.tool].toolkit != self.toolkit:
            raise ValueError("toolkit does not match tool")
        return self


class ActionPlanContent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    decision: Decision
    rationale: str = Field(min_length=1, max_length=500)
    clarification_question: str | None = None
    planner_provider: Literal["fake", "openai"]
    tools_mode: Literal["fake", "composio"]
    references: list[StrictInt] = Field(min_length=1, max_length=1)
    actions: list[StoredAction] = Field(default_factory=list, max_length=MAX_ACTIONS)

    @model_validator(mode="after")
    def _indexed(self) -> "ActionPlanContent":
        if [a.index for a in self.actions] != list(range(len(self.actions))):
            raise ValueError("actions must be indexed 0..n-1")
        if self.decision != "act" and self.actions:
            raise ValueError("only an 'act' plan has actions")
        return self


def plan_json(content: ActionPlanContent) -> str:
    return content.model_dump_json()


def _history_fields(content: ActionPlanContent) -> dict:
    """Per-action comparable payload for provenance (arguments + enabled, not the binding)."""
    out = {}
    for a in content.actions:
        block = ARGUMENT_BLOCK[a.tool]
        out[f"a{a.index}"] = {"enabled": a.enabled, block: getattr(a, block).model_dump()}
    return out


# -------------------------------------------------------------- catalog
_catalog_cache: dict[tuple[str, str, str], tuple[float, str]] = {}
_catalog_lock = threading.Lock()
_CATALOG_TTL_SECONDS = 600.0


def resolve_catalog(transport: ToolTransport) -> dict[str, str]:
    """Verified catalog tools -> the exact toolkit version to pin. Read-only.

    A tool is withheld if its toolkit is not configured, its live schema is
    unavailable, deprecated, tagged destructive, or lacks any argument this
    server would send. Nothing outside ``CATALOG`` is ever considered.
    """
    from app.services.tool_connection_service import toolkit_configured

    resolved: dict[str, str] = {}
    now = time.monotonic()
    for slug, tool in CATALOG.items():
        if not toolkit_configured(tool.toolkit):
            continue
        pin = config.COMPOSIO_TOOLKIT_VERSIONS.get(tool.toolkit) if transport.mode == "composio" else None
        key = (transport.mode, slug, pin or "")
        with _catalog_lock:
            hit = _catalog_cache.get(key)
        if hit is not None and now - hit[0] < _CATALOG_TTL_SECONDS:
            resolved[slug] = hit[1]
            continue
        try:
            info = transport.get_tool(slug, pin)
        except ToolTransportError:
            continue
        if (
            info.slug != slug
            or info.toolkit != tool.toolkit
            or info.deprecated
            or info.tags & FORBIDDEN_TAGS
            or not tool.argument_keys <= info.input_properties
            or not info.required <= tool.always_sent
            or (pin is not None and info.version != pin)
            or (info.available_versions and info.version not in info.available_versions)
        ):
            continue
        with _catalog_lock:
            _catalog_cache[key] = (now, info.version)
        resolved[slug] = info.version
    return resolved


def clear_catalog_cache() -> None:
    with _catalog_lock:
        _catalog_cache.clear()


# ---------------------------------------------------------------- errors
class ActionPlanError(Exception):
    """Base error (safe messages)."""


class ActionPlanNotFoundError(ActionPlanError):
    pass


class ActionPlanUnavailableError(ActionPlanError):
    pass


class ActionPlanEditValidationError(ActionPlanError):
    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.field = field


class ActionPlanNotRevisableError(ActionPlanError):
    """Only an 'act' plan has actions to revise."""


class ActionPlanToolsDisabledError(ActionPlanError):
    """EXTERNAL_TOOLS_MODE=off."""


@dataclass(frozen=True)
class ActionPlanVersion:
    artifact_id: int
    version_id: int
    version_number: int
    origin: str
    content: ActionPlanContent
    source_screenshot_ids: list[int]
    field_origins: dict[str, dict] | None
    content_sha256: str


@dataclass(frozen=True)
class PlanningOutcome:
    operation: OperationState
    artifact_id: int | None = None


def plan_key_prefix(screenshot_id: int) -> str:
    return preparation_key_prefix(screenshot_id, ACTION_PLAN_ACTION)


def plan_key(screenshot_id: int, provider: str, tools_mode: str) -> str:
    # Shares the preparation key shape so the dispatch boundary applies its
    # screenshot-active check under the workspace lock (``_check_policy``).
    return f"{plan_key_prefix(screenshot_id)}tools:{tools_mode}:provider:{provider}"


# ---------------------------------------------------------------- service
class ActionPlanService:
    def __init__(self, session: Session, workspace_id: int, *, adapter: AIAdapter | None = None,
                 transport: ToolTransport | None = None, vault: VaultService | None = None) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        self._session = session
        self._workspace_id = workspace_id
        self._adapter = adapter
        self._transport = transport if transport is not None else get_tool_transport()
        self._repo = WorkspaceRepository(session, workspace_id)
        self._tools = ToolRepository(session, workspace_id)
        self._versions = ArtifactVersionService(session, workspace_id)
        self._operations = OperationService(session, workspace_id)
        self._consent = ConsentService(session, workspace_id)
        self._vault = vault
        self._dispatch = AIDispatchService(session, workspace_id)

    # -------------------------------------------------------------- request
    def request_planning(self, screenshot_id: int, *, replan: bool = False) -> tuple[OperationState, bool]:
        """Start (or reuse) planning for one screenshot. Never calls the AI itself.

        Reuses a running plan, and (unless ``replan``) the newest plan that was
        produced. Consent and quota are checked only when a new operation is
        created, under the workspace lock, like every preparation.
        """
        from app.services.preparation_service import PERMITTED_PROVIDERS

        if config.EXTERNAL_TOOLS_MODE == "off" or self._transport is None:
            raise ActionPlanToolsDisabledError("external apps are not enabled")
        if config.AI_PROVIDER not in PERMITTED_PROVIDERS:
            raise ActionPlanUnavailableError("AI planning unavailable")
        try:
            shot = self._repo.get_screenshot(screenshot_id)
        except SQLAlchemyError as exc:
            raise ActionPlanUnavailableError("action plans unavailable") from exc
        if shot is None:
            raise ActionPlanNotFoundError("not found")
        if shot.state != "active":
            raise DraftSourceArchivedError("archived")

        def after_lock() -> None:
            locked = self._repo.get_screenshot_locked(screenshot_id)
            if locked is None:
                raise ActionPlanNotFoundError("not found")
            if locked.state != "active":
                raise DraftSourceArchivedError("archived")

        def reusable(state: OperationState) -> bool:
            return state.status == "pending" or (not replan and state.artifact_id is not None)

        return self._operations.create_or_reuse_keyed(
            KIND_ACTION_PLAN,
            plan_key(screenshot_id, config.AI_PROVIDER, config.EXTERNAL_TOOLS_MODE),
            key_prefix=plan_key_prefix(screenshot_id),
            reusable=reusable,
            after_lock=after_lock,
            before_create=lambda: self._consent.require_consent(screenshot_id),
        )

    # -------------------------------------------------------------- planning
    def _active_bindings(self) -> dict[str, Destination]:
        out: dict[str, Destination] = {}
        for toolkit in {t.toolkit for t in CATALOG.values()}:
            row = self._tools.current_connection(toolkit)
            if row is not None and row.status == "active" and self._transport is not None and row.mode == self._transport.mode:
                out[toolkit] = Destination(connection_id=row.id, connected_account_id=row.connected_account_id, mode=row.mode)
        return out

    def run_planning(self, screenshot_id: int, operation_id: int) -> PlanningOutcome:
        current = self._operations.get(operation_id)
        if current.kind != KIND_ACTION_PLAN or current.status != "pending":
            return PlanningOutcome(operation=current)
        if self._adapter is None or not isinstance(self._adapter, ActionPlanner):
            return self._fail(operation_id, "AI planning unavailable")
        if self._transport is None or self._transport.mode != config.EXTERNAL_TOOLS_MODE:
            return self._fail(operation_id, "External apps are not enabled")
        try:
            self._consent.require_consent(screenshot_id)
        except ConsentRequiredError:
            return self._fail(operation_id, "AI processing consent required")
        except ConsentScreenshotNotFoundError:
            return self._fail(operation_id, "Not found")
        except ConsentServiceUnavailableError:
            return self._fail(operation_id, "AI processing unavailable")
        versions = resolve_catalog(self._transport)
        if not versions:
            return self._fail(operation_id, "No supported app is available right now")
        try:
            bindings = self._active_bindings()
            self._session.rollback()
        except SQLAlchemyError:
            self._session.rollback()
            return self._fail(operation_id, "AI processing unavailable")
        tools = [
            PlannerTool(slug=s, app=CATALOG[s].label, description=CATALOG[s].planner_description,
                        connected=CATALOG[s].toolkit in bindings)
            for s in CATALOG if s in versions
        ]
        vault = self._vault or VaultService(self._session, self._workspace_id)
        try:
            original = vault.read_original(screenshot_id)
        except (VaultScreenshotNotFoundError, VaultServiceError):
            return self._fail(operation_id, "Not found")
        if original.byte_size > config.AI_MAX_INPUT_IMAGE_BYTES:
            return self._fail(operation_id, "AI input exceeds configured limits")
        images = [(screenshot_id, original.data, original.mime_type)]
        del original
        try:
            ticket = self._dispatch.authorize(
                operation_id, [screenshot_id], adapter_provider=getattr(self._adapter, "provider_id", None)
            )
        except DispatchSupersededError:
            images.clear()
            return PlanningOutcome(operation=self._operations.get(operation_id))
        except DispatchDeniedError as exc:
            images.clear()
            return self._fail(operation_id, exc.detail)
        try:
            raw = self._adapter.plan_actions(images, tools)  # EXACTLY ONE call
        except Exception as exc:
            self._dispatch.discard(ticket)
            return self._fail(operation_id, adapter_failure_detail(exc))
        finally:
            images.clear()
        try:
            payload = raw.model_dump() if isinstance(raw, BaseModel) else raw
            result = PlannerOutput.model_validate(payload)
        except Exception:
            self._dispatch.discard(ticket)
            return self._fail(operation_id, "AI output failed validation")
        if result.references != [screenshot_id]:
            self._dispatch.discard(ticket)
            return self._fail(operation_id, "AI output references invalid")
        if any(a.tool not in versions for a in result.actions):
            # The model named a tool it was not offered: never stored.
            self._dispatch.discard(ticket)
            return self._fail(operation_id, "AI output failed validation")
        content = ActionPlanContent(
            decision=result.decision,
            rationale=result.rationale,
            clarification_question=result.clarification_question,
            planner_provider=config.AI_PROVIDER,
            tools_mode=self._transport.mode,
            references=[screenshot_id],
            actions=[
                StoredAction(
                    **a.model_dump(),
                    index=i,
                    toolkit=CATALOG[a.tool].toolkit,
                    toolkit_version=versions[a.tool],
                    destination=bindings.get(CATALOG[a.tool].toolkit),
                )
                for i, a in enumerate(result.actions)
            ],
        )
        created: dict[str, int] = {}

        def _persist() -> int:
            art = self._repo.create_artifact(kind=KIND_ACTION_PLAN)
            self._versions.create_first_version(art.id, plan_json(content), _ORIGIN_AI_GENERATE)
            self._repo.add_source_reference(artifact_id=art.id, screenshot_id=screenshot_id)
            created["artifact_id"] = art.id
            return art.id

        uncertain = result.decision == "needs_clarification" or any(
            action_problems(a) or (a.calendar is not None and a.calendar.uncertain_fields) for a in content.actions
        )
        try:
            op = self._operations.complete_after_persistence(
                operation_id, _persist,
                terminal_status="uncertain" if uncertain else "successful",
                guard=lambda: self._dispatch.verify_for_persistence(ticket),
            )
        except (OperationPersistenceError, OperationTransitionError):
            self._dispatch.discard(ticket)
            return PlanningOutcome(operation=self._operations.get(operation_id))
        return PlanningOutcome(operation=op, artifact_id=created.get("artifact_id"))

    def _fail(self, operation_id: int, detail: str) -> PlanningOutcome:
        try:
            op = self._operations.set_terminal_status(operation_id, "failed", error_detail=detail)
        except OperationTransitionError:
            op = self._operations.get(operation_id)
        return PlanningOutcome(operation=op)

    # ------------------------------------------------------------------ reads
    def latest_for_screenshot(self, screenshot_id: int):
        """The newest planning operation for this screenshot, or None."""
        try:
            if self._repo.get_screenshot(screenshot_id) is None:
                raise ActionPlanNotFoundError("not found")
            return self._repo.latest_operation_with_key_prefix(plan_key_prefix(screenshot_id))
        except SQLAlchemyError as exc:
            raise ActionPlanUnavailableError("action plans unavailable") from exc

    def get_version(self, artifact_id: int, version_id: int | None = None) -> ActionPlanVersion:
        try:
            artifact = self._plan(artifact_id)
            selected = artifact.current_version_id if version_id is None else version_id
            if selected is None or type(selected) is not int:
                raise ActionPlanNotFoundError("not found")
            version = self._repo.get_artifact_version(selected)
            if version is None or version.artifact_id != artifact.id:
                raise ActionPlanNotFoundError("not found")
            return self._view(artifact, version)
        except CrossWorkspaceError as exc:
            raise ActionPlanNotFoundError("not found") from exc
        except SQLAlchemyError as exc:
            raise ActionPlanUnavailableError("action plans unavailable") from exc

    def list_versions(self, artifact_id: int) -> list[dict]:
        try:
            artifact = self._plan(artifact_id)
            return [
                {"versionId": v.id, "versionNumber": v.version_number, "origin": v.origin,
                 "isCurrent": v.id == artifact.current_version_id}
                for v in sorted(self._repo.list_artifact_versions(artifact.id), key=lambda v: v.version_number)
            ]
        except CrossWorkspaceError as exc:
            raise ActionPlanNotFoundError("not found") from exc
        except SQLAlchemyError as exc:
            raise ActionPlanUnavailableError("action plans unavailable") from exc

    # -------------------------------------------------------------- revisions
    def save_revision(self, artifact_id: int, base_version_id: int, raw_actions: object) -> tuple[ActionPlanVersion, str]:
        """Append ONE ``manual_edit`` version from the user's reviewed actions.

        Each entry is ``{"index", "enabled", <block>: {...}}`` for an existing
        action; tools cannot be changed or added. Destinations are re-bound to
        the workspace's CURRENT active connection by the server. Returns
        ``(version, "created" | "unchanged")``. A stale base is a conflict.
        """
        try:
            if self._repo.lock_workspace() is None:
                raise ActionPlanNotFoundError("not found")
            artifact = self._plan(artifact_id)
            if type(base_version_id) is not int or base_version_id <= 0:
                raise ActionPlanNotFoundError("not found")
            base = self._repo.get_artifact_version(base_version_id)
            current = self._repo.get_artifact_version(artifact.current_version_id) if artifact.current_version_id else None
            if base is None or base.artifact_id != artifact.id or current is None:
                raise ActionPlanNotFoundError("not found")
            if base.id != current.id:
                raise DraftVersionConflictError(current.id, current.version_number)
            content = self._parse(current.content_json)
            sources = self._sources(artifact.id, content)
            require_sources_active(self._repo, sources)
            if content.decision != "act":
                raise ActionPlanNotRevisableError("this plan has no actions")
            candidate = self._candidate(content, raw_actions, sources)
            if candidate.model_dump() == content.model_dump():
                outcome = (self._view(artifact, current), "unchanged")
                self._session.rollback()
                return outcome
            version = self._versions.append_version(artifact.id, plan_json(candidate), ORIGIN_MANUAL_EDIT)
            # Same locked transaction: a reservation of the replaced version was
            # never sent and must not be (the dispatch boundary re-checks too).
            from app.services.tool_execution_service import cancel_reserved_locked

            cancel_reserved_locked(self._session, self._workspace_id, artifact_id=artifact.id,
                                   detail="Cancelled before sending: the plan was edited.")
            outcome = (self._view(artifact, version), "created")
            self._session.commit()
            return outcome
        except (ActionPlanError, DraftVersionConflictError, DraftSourceArchivedError):
            self._session.rollback()
            raise
        except (DraftSourceMissingError, VersionConflictError, SQLAlchemyError) as exc:
            self._session.rollback()
            raise ActionPlanUnavailableError("action plans unavailable") from exc
        except CrossWorkspaceError as exc:
            self._session.rollback()
            raise ActionPlanNotFoundError("not found") from exc
        except Exception as exc:
            self._session.rollback()
            raise ActionPlanUnavailableError("action plans unavailable") from exc

    def _candidate(self, base: ActionPlanContent, raw_actions: object, sources: list[int]) -> ActionPlanContent:
        if not isinstance(raw_actions, list) or len(raw_actions) != len(base.actions):
            raise ActionPlanEditValidationError("Send every action of the plan, in order.")
        bindings = self._active_bindings()
        actions: list[StoredAction] = []
        for old, raw in zip(base.actions, raw_actions):
            if not isinstance(raw, dict) or raw.get("index") != old.index:
                raise ActionPlanEditValidationError("Send every action of the plan, in order.")
            block = ARGUMENT_BLOCK[old.tool]
            allowed = {"index", "enabled", block}
            if set(raw) - allowed or type(raw.get("enabled")) is not bool or block not in raw:
                raise ActionPlanEditValidationError("This action can only change its own fields.")
            values = {"enabled": raw["enabled"]}
            try:
                if block == "calendar":
                    edit = EventDraftEditContent.model_validate(
                        {f: raw[block].get(f) for f in EVENT_DRAFT_FIELDS} if isinstance(raw[block], dict) else None
                    )
                    flags = raw[block].get("uncertain_fields", []) if isinstance(raw[block], dict) else []
                    if not isinstance(flags, list) or any(f not in EVENT_DRAFT_FIELDS for f in flags):
                        raise ActionPlanEditValidationError("Unknown uncertain field.")
                    values["calendar"] = EventDraftArtifactService._candidate(old.calendar, edit, frozenset(flags), sources)
                elif block == "notion":
                    values["notion"] = NotionPageArgs.model_validate(raw[block])
                else:
                    values["gmail"] = GmailDraftArgs.model_validate(raw[block])
            except EventDraftEditValidationError as exc:
                raise ActionPlanEditValidationError(exc.message, f"a{old.index}.{exc.field}" if exc.field else None) from exc
            except ValidationError as exc:
                err = exc.errors()[0]
                loc = err.get("loc") or ()
                field = f"a{old.index}.{loc[0]}" if loc else None
                raise ActionPlanEditValidationError("This value is not valid.", field) from exc
            actions.append(old.model_copy(update={**values, "destination": bindings.get(old.toolkit)}))
        try:
            return ActionPlanContent.model_validate({**base.model_dump(), "actions": [a.model_dump() for a in actions]})
        except ValidationError as exc:
            raise ActionPlanEditValidationError("This plan is not valid.") from exc

    # -------------------------------------------------------------- internals
    def _plan(self, artifact_id: int):
        if type(artifact_id) is not int or artifact_id <= 0:
            raise ActionPlanNotFoundError("not found")
        artifact = self._repo.get_artifact(artifact_id)
        if artifact is None or artifact.kind != KIND_ACTION_PLAN:
            raise ActionPlanNotFoundError("not found")
        return artifact

    def _view(self, artifact, version) -> ActionPlanVersion:
        import hashlib

        content = self._parse(version.content_json)
        sources = self._sources(artifact.id, content)

        def history(raw: str) -> dict:
            parsed = self._parse(raw)
            if parsed.references != sources:
                raise ActionPlanUnavailableError("action plans unavailable")
            return _history_fields(parsed)

        return ActionPlanVersion(
            artifact_id=artifact.id,
            version_id=version.id,
            version_number=version.version_number,
            origin=version.origin,
            content=content,
            source_screenshot_ids=sources,
            field_origins=field_origins(
                self._repo.list_artifact_versions(artifact.id), version.version_number,
                PLAN_FIELDS[: len(content.actions)], history,
            ),
            content_sha256=hashlib.sha256(version.content_json.encode("utf-8")).hexdigest(),
        )

    def _sources(self, artifact_id: int, content: ActionPlanContent) -> list[int]:
        sources = [ref.screenshot_id for ref in self._repo.list_source_references(artifact_id)]
        if len(sources) != 1 or content.references != sources or self._repo.get_screenshot(sources[0]) is None:
            raise ActionPlanUnavailableError("action plans unavailable")
        for a in content.actions:
            if a.calendar is not None and a.calendar.references != sources:
                raise ActionPlanUnavailableError("action plans unavailable")
        return sources

    @staticmethod
    def _parse(content_json: str) -> ActionPlanContent:
        try:
            return ActionPlanContent.model_validate(json.loads(content_json))
        except (json.JSONDecodeError, ValidationError, TypeError, ValueError) as exc:
            raise ActionPlanUnavailableError("action plans unavailable") from exc


# ------------------------------------------------------------- eligibility
def plan_eligibility(view: ActionPlanVersion) -> tuple[list[dict], list[str], list[str]]:
    """(reasons, required acknowledgements, AI-origin fields) for approving a plan version."""
    c = view.content
    reasons: list[dict] = []
    if c.decision != "act":
        reasons.append({"field": None, "code": "no_action", "message": "This plan proposes no action to approve."})
    enabled = [a for a in c.actions if a.enabled]
    if c.decision == "act" and not enabled:
        reasons.append({"field": None, "code": "nothing_enabled", "message": "Turn on at least one action."})
    if c.tools_mode != config.EXTERNAL_TOOLS_MODE:
        reasons.append({"field": None, "code": "tools_mode_changed",
                        "message": "External apps changed since this plan was made. Plan again."})
    uncertain: list[str] = []
    for a in enabled:
        for p in action_problems(a):
            reasons.append({"field": f"a{a.index}.{p['field']}", "code": "missing", "message": p["message"]})
        if a.destination is None:
            reasons.append({"field": f"a{a.index}", "code": "connection_required",
                            "message": f"Connect {TOOLKIT_LABELS[a.toolkit]} first, then save the plan again."})
        if a.calendar is not None:
            uncertain += [f"a{a.index}.{f}" for f in a.calendar.uncertain_fields]
    origins = view.field_origins or {}
    ai_fields = sorted(
        f"a{a.index}" for a in enabled
        if origins.get(f"a{a.index}", {}).get("origin") in {"ai_generate", "ai_redo"}
    )
    return reasons, sorted(uncertain), ai_fields


def find_action(content: ActionPlanContent, index: int) -> StoredAction | None:
    if type(index) is not int or index < 0 or index >= len(content.actions):
        return None
    return content.actions[index]


__all__ = [
    "ACK_FIELDS",
    "ActionPlanContent",
    "ActionPlanService",
    "ActionPlanVersion",
    "KIND_ACTION_PLAN",
    "PLAN_FIELDS",
    "StoredAction",
    "TOOL_CALENDAR",
    "ToolSlug",
    "plan_eligibility",
    "resolve_catalog",
]
