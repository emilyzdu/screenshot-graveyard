"""Auto-processing (Batch 6B): analysis -> routing -> draft preparation, opt-in.

One bounded orchestration over the EXISTING services. It adds no AI system and
no new operation kind:

* analysis is the existing ``classify`` operation, run by
  ``ClassificationService.run_classification``. Every classify request (manual
  Revive or automatic) now carries a per-screenshot idempotency key, so a
  second request while one is running reuses it instead of paying twice;
* routing is ``action_router.route_from_analysis``, a pure function of the
  stored analysis, recomputed on every read (nothing extra to store or drift);
* preparation is the existing ``PreparationService.request`` (keyed per
  screenshot and action) and its unchanged workers.

The pipeline state is DERIVED from those persisted operations plus an
in-process registry of running pipelines (it only distinguishes "routing" from
"ready to prepare" in the moment between analysis and preparation; after a
restart nothing is running, and the derived state offers an explicit step).

Safety:
* ``auto_prepare`` is a workspace preference. It never grants consent: every
  screenshot needs its own provider- and disclosure-bound grant, re-checked by
  the dispatch boundary at EACH adapter call (analysis and preparation);
* nothing is retried automatically. A failed or unconfirmed step is shown as
  such; only an explicit request starts it again;
* the automatic step never runs if the user already started a draft for any
  action on this screenshot (manual choice wins), if the preference was turned
  off, or if the screenshot was archived; all checked under the workspace lock;
* nothing is approved and nothing is delivered anywhere.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app import config
from app.db.repository import WorkspaceRepository
from app.services.action_router import ROUTABLE_ACTIONS, Route, route_from_analysis
from app.services.analysis_service import (
    AnalysisNotFoundError,
    AnalysisService,
    AnalysisUnavailableError,
)
from app.services.consent_service import ConsentService, ConsentServiceUnavailableError
from app.services.operation_service import OperationService, OperationState
from app.services.preparation_service import (
    AUTO_SEGMENT,
    PERMITTED_PROVIDERS,
    PreparationService,
    key_prefix as prepare_key_prefix,
    provider_from_key,
    trigger_from_key,
)

CLASSIFY_KIND = "classify"


class AutoProcessError(Exception):
    """Base class (generic messages only)."""


class AutoProcessNotFoundError(AutoProcessError):
    pass


class AutoProcessArchivedError(AutoProcessError):
    pass


class AutoProcessDisabledError(AutoProcessError):
    pass


class AutoProcessUnavailableError(AutoProcessError):
    pass


class ClassifyNotNeededError(AutoProcessError):
    """A current analysis already exists for this provider: an initial analysis
    would only pay again. Regenerating is the explicit Redo."""


class AutoStepSkipped(Exception):
    """The automatic preparation must not run (raised inside the lock; nothing written)."""

    def __init__(self, why: str) -> None:
        super().__init__(why)
        self.why = why


# ------------------------------------------------------------ classify identity

def classify_key_prefix(screenshot_id: int) -> str:
    return f"classify:screenshot:{screenshot_id}:"


def classify_key(screenshot_id: int, provider: str, *, auto: bool = False) -> str:
    return f"{classify_key_prefix(screenshot_id)}{AUTO_SEGMENT if auto else ''}provider:{provider}"


_AI_ORIGINS = frozenset({"ai_generate", "ai_redo"})


def current_analysis_stands(session: Session, workspace_id: int, screenshot_id: int) -> bool:
    """Is there an analysis an initial classification would only duplicate?

    Yes for any saved analysis, EXCEPT one an AI provider wrote that is not the
    configured provider (a Fake result does not stand in for a real-AI one).
    A user-edited or legacy analysis stands too: regenerating is the explicit
    Redo, never a second initial classification. Call under the workspace lock.
    """
    try:
        view = AnalysisService(session, workspace_id).get_analysis(screenshot_id)
    except AnalysisNotFoundError:
        return False
    if view.classification_origin in _AI_ORIGINS and view.classification_provider not in (None, config.AI_PROVIDER):
        return False
    return True


def request_classify(
    session: Session, workspace_id: int, screenshot_id: int, *, after_lock=None, auto: bool = False
) -> tuple[OperationState, bool]:
    """Create or reuse the keyed classify operation for one screenshot.

    Decided under the workspace lock: a RUNNING analysis is reused, and so is a
    successful one whose saved analysis still stands for this provider (a
    replayed or lost-response request pays nothing). Otherwise, if an analysis
    already stands (e.g. from before keys existed), nothing is created
    (``ClassifyNotNeededError``). Consent is checked only when a new operation
    is created (``ConsentRequiredError``; nothing written). Returns
    ``(state, reused)``.
    """
    consent = ConsentService(session, workspace_id)

    def reusable(state: OperationState) -> bool:
        if state.status == "pending":
            return True
        return state.status == "successful" and current_analysis_stands(session, workspace_id, screenshot_id)

    def before_create() -> None:
        if current_analysis_stands(session, workspace_id, screenshot_id):
            raise ClassifyNotNeededError("already analyzed")
        consent.require_consent(screenshot_id)

    return OperationService(session, workspace_id).create_or_reuse_keyed(
        CLASSIFY_KIND,
        classify_key(screenshot_id, config.AI_PROVIDER, auto=auto),
        key_prefix=classify_key_prefix(screenshot_id),
        reusable=reusable,
        after_lock=after_lock,
        before_create=before_create,
    )


def auto_route_now(session: Session, workspace_id: int, screenshot_id: int) -> str | None:
    """The action the canonical router would prepare automatically RIGHT NOW,
    from a fresh read of the saved analysis (call under the workspace lock), or
    None. The single source for every "may this still run automatically" check."""
    session.expire_all()  # never decide from objects loaded before the lock
    try:
        view = AnalysisService(session, workspace_id).get_analysis(screenshot_id)
    except (AnalysisNotFoundError, AnalysisUnavailableError):
        return None
    r = route_from_analysis(view)
    return r.action if r.decision == "auto" and r.action in ROUTABLE_ACTIONS else None


# ------------------------------------------------------------ running registry

class _Running:
    """In-process set of (workspace, screenshot) pipelines currently executing."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._keys: set[tuple[int, int]] = set()

    def claim(self, workspace_id: int, screenshot_id: int) -> bool:
        with self._lock:
            key = (workspace_id, screenshot_id)
            if key in self._keys:
                return False
            self._keys.add(key)
            return True

    def release(self, workspace_id: int, screenshot_id: int) -> None:
        with self._lock:
            self._keys.discard((workspace_id, screenshot_id))

    def is_running(self, workspace_id: int, screenshot_id: int) -> bool:
        with self._lock:
            return (workspace_id, screenshot_id) in self._keys


RUNNING = _Running()


# ------------------------------------------------------------ derived state

@dataclass(frozen=True)
class StepState:
    operation_id: int
    status: str
    artifact_id: int | None
    error_detail: str | None
    provider: str | None = None
    action: str | None = None
    trigger: str | None = None


@dataclass(frozen=True)
class AutoState:
    screenshot_id: int
    enabled: bool
    consent: bool
    stage: str
    route: Route | None
    analysis: StepState | None
    preparation: StepState | None
    running: bool


# Stages (adapted to existing operation statuses; see docs in the router):
#   archived, awaiting_consent, not_started, analyzing, analysis_failed,
#   routing, ready_to_prepare, preparing, ready_for_review, preparation_failed,
#   needs_choice, recommended, reference


def _step(op, action: str | None = None) -> StepState | None:
    if op is None:
        return None
    return StepState(op.id, op.status, op.artifact_id, op.error_detail, provider_from_key(op.idempotency_key), action,
                     trigger_from_key(op.idempotency_key))


class AutoProcessService:
    def __init__(self, session: Session, workspace_id: int) -> None:
        if workspace_id is None:
            raise ValueError("workspace_id is required")
        self._session = session
        self._workspace_id = workspace_id
        self._repo = WorkspaceRepository(session, workspace_id)

    # -- preference
    def preference(self) -> bool:
        try:
            return self._repo.get_auto_prepare()
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise AutoProcessUnavailableError("unavailable") from exc

    def set_preference(self, enabled: bool) -> bool:
        try:
            if self._repo.lock_workspace() is None or not self._repo.set_auto_prepare(enabled):
                self._session.rollback()
                raise AutoProcessUnavailableError("unavailable")
            self._session.commit()
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise AutoProcessUnavailableError("unavailable") from exc
        return bool(enabled)

    # -- reads
    def _latest_preparation(self, screenshot_id: int):
        """The newest preparation for any action on this screenshot (and its action)."""
        newest, newest_action = None, None
        for action in ROUTABLE_ACTIONS:
            op = self._repo.latest_operation_with_key_prefix(prepare_key_prefix(screenshot_id, action))
            if op is not None and (newest is None or op.id > newest.id):
                newest, newest_action = op, action
        return newest, newest_action

    def state(self, screenshot_id: int, *, ignore_running: bool = False) -> AutoState:
        try:
            shot = self._repo.get_screenshot(screenshot_id)
            if shot is None:
                raise AutoProcessNotFoundError("not found")
            enabled = self._repo.get_auto_prepare()
            try:
                consent = ConsentService(self._session, self._workspace_id).has_consent(screenshot_id)
            except ConsentServiceUnavailableError as exc:
                raise AutoProcessUnavailableError("unavailable") from exc
            try:
                view = AnalysisService(self._session, self._workspace_id).get_analysis(screenshot_id)
            except AnalysisNotFoundError:
                view = None
            except AnalysisUnavailableError as exc:
                raise AutoProcessUnavailableError("unavailable") from exc
            classify_op = self._repo.latest_operation_with_key_prefix(classify_key_prefix(screenshot_id))
            prep_op, prep_action = self._latest_preparation(screenshot_id)
        except SQLAlchemyError as exc:
            self._session.rollback()
            raise AutoProcessUnavailableError("unavailable") from exc
        running = False if ignore_running else RUNNING.is_running(self._workspace_id, screenshot_id)
        route = route_from_analysis(view) if view is not None else None
        analysis = _step(classify_op)
        preparation = _step(prep_op, prep_action)
        stage = self._stage(shot.state, consent, view is not None, analysis, route, preparation, running)
        return AutoState(screenshot_id, enabled, consent, stage, route, analysis, preparation, running)

    @staticmethod
    def _stage(shot_state, consent, has_analysis, analysis, route, preparation, running) -> str:
        if shot_state != "active":
            return "archived"
        if not has_analysis:
            if analysis is not None and analysis.status == "pending":
                return "analyzing"
            if running:
                return "analyzing"
            if analysis is not None and analysis.status in {"failed", "uncertain"}:
                return "analysis_failed"
            return "not_started" if consent else "awaiting_consent"
        # A draft (any action) stands over the router's opinion: it is what exists.
        if preparation is not None:
            if preparation.status == "pending":
                return "preparing"
            if preparation.artifact_id is not None:
                return "ready_for_review"
            if route is not None and route.decision == "auto" and route.action == preparation.action:
                return "preparation_failed"
        if route is None:
            return "needs_choice"
        if route.decision == "auto":
            return "routing" if running else "ready_to_prepare"
        if route.decision == "recommend":
            return "recommended"
        if route.decision == "keep_reference":
            return "reference"
        return "needs_choice"

    # -- start
    def start(self, screenshot_id: int) -> tuple[AutoState, OperationState | None, bool]:
        """Explicit request to continue automatically. Never calls an adapter.

        Returns ``(state, new_classify_op, run_pipeline)``: the NEW classify
        operation to execute (None when an analysis exists or one is already
        running) and whether the pipeline job should run at all (a new
        analysis, or an analysis that is routed but not yet prepared). Raises
        ``ConsentRequiredError`` when a new analysis would be needed without
        consent.
        """
        if config.AI_PROVIDER not in PERMITTED_PROVIDERS:
            raise AutoProcessUnavailableError("provider")
        # The caller holds this screenshot's running claim: judge the persisted
        # state alone, then report it as running only if work is scheduled.
        current = self.state(screenshot_id, ignore_running=True)
        if current.stage == "archived":
            raise AutoProcessArchivedError("archived")
        if not current.enabled:
            raise AutoProcessDisabledError("disabled")
        if current.stage in {"analysis_failed", "not_started", "awaiting_consent"}:
            try:
                state, reused = request_classify(
                    self._session, self._workspace_id, screenshot_id,
                    after_lock=lambda: self._require_active_locked(screenshot_id), auto=True,
                )
            except ClassifyNotNeededError:
                # Another analysis finished meanwhile: only the routed step remains.
                current = self.state(screenshot_id, ignore_running=True)
                run = current.stage == "ready_to_prepare"
                return (self.state(screenshot_id) if run else current), None, run
            new_op = None if reused else state
            run = new_op is not None
            return self.state(screenshot_id, ignore_running=not run), new_op, run
        run = current.stage == "ready_to_prepare"
        return (self.state(screenshot_id) if run else current), None, run

    def _require_active_locked(self, screenshot_id: int) -> None:
        shot = self._repo.get_screenshot_locked(screenshot_id)
        if shot is None:
            raise AutoProcessNotFoundError("not found")
        if shot.state != "active":
            raise AutoProcessArchivedError("archived")

    # -- the automatic preparation step (runs inside the pipeline job)
    def auto_preparation(self, screenshot_id: int):
        """Request the routed preparation if, and only if, it may run now.

        Returns the ``Preparation`` (possibly reused) or None when skipped.
        Everything that could make it wrong is re-checked under the workspace
        lock in ``PreparationService.request``: preference still on, no draft
        started for ANY action (a manual choice wins), screenshot active, and
        consent (only when a new operation is created). The adapter call itself
        is re-authorized by the dispatch boundary.
        """
        try:
            view = AnalysisService(self._session, self._workspace_id).get_analysis(screenshot_id)
        except (AnalysisNotFoundError, AnalysisUnavailableError):
            return None
        decision = route_from_analysis(view)
        if decision.decision != "auto" or decision.action not in ROUTABLE_ACTIONS:
            return None

        def guard() -> None:
            if not self._repo.get_auto_prepare():
                raise AutoStepSkipped("disabled")
            # The route above was computed before the lock: recompute it from a
            # FRESH read of the saved analysis. An edit committed meanwhile (for
            # example to Potentially Sensitive) means no automatic step.
            if auto_route_now(self._session, self._workspace_id, screenshot_id) != decision.action:
                raise AutoStepSkipped("route_changed")
            # A draft the user started for ANOTHER action wins: never add a
            # competing automatic one. The routed action itself is decided by
            # PreparationService's reuse rule (running or drafted -> reused).
            for action in ROUTABLE_ACTIONS:
                if action == decision.action:
                    continue
                if self._repo.latest_operation_with_key_prefix(prepare_key_prefix(screenshot_id, action)) is not None:
                    raise AutoStepSkipped("user_chose_other")

        try:
            return PreparationService(self._session, self._workspace_id).request(
                screenshot_id, decision.action, guard=guard, auto=True
            )
        except AutoStepSkipped:
            return None
