"""Consent-to-dispatch boundary (Batch 6A, tasks.md 7.1).

Every AI worker (Classification + Redo, Study Notes + Redo, Calendar event
drafts) must call the adapter only after a locked dispatch authorization that
re-reads consent, and must save a result only if consent is still granted at
the authorized version.

File SQLite + NullPool: each "other client" is a real, separate connection, so
the workspace write lock genuinely orders a withdrawal against an
authorization. Orderings are fixed by hooks, never by sleeps (the one bounded
join below only proves a thread is BLOCKED, it never decides an outcome).
"""

from __future__ import annotations

import io
import os
import threading

import pytest
from PIL import Image
from sqlalchemy import create_engine, event, func, select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.ai.fake_adapter import FakeAIAdapter
from app.db import models
from app.db.base import Base
from app.db.repository import WorkspaceRepository
from app.services import ai_dispatch_service as dispatch_mod
from app.services.ai_dispatch_service import AIDispatchService
from app.services.classification_service import ClassificationService
from app.services.consent_service import ConsentService
from app.services.event_draft_service import EventDraftService
from app.services.operation_service import OperationService
from app.services.study_note_service import StudyNoteService
from app.services.vault_service import VaultService
from app.storage.file_store import FileStore
from tests.consent_helpers import current_disclosure

CONSENT_REQUIRED = "AI processing consent required"


def png(color) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (12, 12), color).save(b, format="PNG")
    return b.getvalue()


class Recording:
    """FakeAIAdapter wrapper: counts calls; optional hook runs ON ENTRY (bytes handed over)."""

    def __init__(self, on_enter=None):
        self._fake = FakeAIAdapter()
        self.calls = 0
        self.on_enter = on_enter
        self.in_transaction: list[bool] = []
        self.session: Session | None = None

    def _enter(self):
        self.calls += 1
        if self.session is not None:
            self.in_transaction.append(self.session.in_transaction())
        if self.on_enter:
            hook, self.on_enter = self.on_enter, None
            hook()

    def classify_and_epitaph(self, image_bytes, mime, *, instructions=None):
        self._enter()
        return self._fake.classify_and_epitaph(image_bytes, mime)

    def study_note(self, images, *, instructions=None):
        self._enter()
        return self._fake.study_note(images)

    def event_draft(self, images):
        self._enter()
        return self._fake.event_draft(images)


@pytest.fixture()
def world(tmp_path):
    url = f"sqlite:///{(tmp_path / 'd.db').as_posix()}"
    eng = create_engine(url, poolclass=NullPool, connect_args={"check_same_thread": False, "timeout": 10})
    Base.metadata.create_all(eng)
    store = FileStore(tmp_path / "storage")
    with Session(eng) as s:
        wa, wb = models.Workspace(token_hash="a" * 64), models.Workspace(token_hash="b" * 64)
        s.add_all([wa, wb])
        s.commit()
        ids = (wa.id, wb.id)
    yield eng, store, ids
    for p in (tmp_path / "storage").rglob("*"):
        try:
            os.chmod(p, 0o700)
        except OSError:
            pass


def upload(eng, store, ws, color, *, consent=True) -> int:
    with Session(eng) as s:
        sid = VaultService(s, ws, file_store=store).upload(png(color), filename="x.png").screenshot_id
        if consent:
            ConsentService(s, ws).record_consent(sid, True, disclosure=current_disclosure())
        return sid


def pending(eng, ws, kind) -> int:
    with Session(eng) as s:
        return OperationService(s, ws).create_pending(kind).operation_id


def set_consent_elsewhere(eng, ws, sid, granted):
    """A different client's request: its own connection, as the HTTP route would."""
    with Session(eng) as other:
        ConsentService(other, ws).record_consent(sid, granted, disclosure=current_disclosure() if granted else None)


def counts(eng):
    with Session(eng) as s:
        return {
            "artifacts": s.scalar(select(func.count()).select_from(models.Artifact)),
            "versions": s.scalar(select(func.count()).select_from(models.ArtifactVersion)),
            "refs": s.scalar(select(func.count()).select_from(models.SourceReference)),
        }


def dispatch_rows(eng, op_id):
    with Session(eng) as s:
        return [
            (r.screenshot_id, r.state, r.consent_version)
            for r in s.scalars(select(models.AIDispatch).where(models.AIDispatch.operation_id == op_id).order_by(models.AIDispatch.id))
        ]


def op_state(eng, op_id):
    with Session(eng) as s:
        op = s.get(models.Operation, op_id)
        return op.status, op.error_detail


# ----------------------------------------------------------------- one runner per worker
def run_classify(eng, store, ws, sid, adapter, op_id=None):
    op_id = op_id or pending(eng, ws, "classify")
    with Session(eng) as s:
        adapter.session = s
        ClassificationService(s, ws, adapter=adapter, vault=VaultService(s, ws, file_store=store)).run_classification(sid, op_id)
    return op_id


def run_notes(eng, store, ws, sids, adapter, op_id=None):
    op_id = op_id or pending(eng, ws, "study_note")
    with Session(eng) as s:
        adapter.session = s
        StudyNoteService(s, ws, adapter=adapter, vault=VaultService(s, ws, file_store=store)).run_generation(sids, op_id)
    return op_id


def run_event(eng, store, ws, sid, adapter, op_id=None):
    op_id = op_id or pending(eng, ws, "event_draft")
    with Session(eng) as s:
        adapter.session = s
        EventDraftService(s, ws, adapter=adapter, vault=VaultService(s, ws, file_store=store)).run_generation(sid, op_id)
    return op_id


WORKERS = {
    "classify": lambda eng, store, ws, sids, a, op=None: run_classify(eng, store, ws, sids[0], a, op),
    "study_note": lambda eng, store, ws, sids, a, op=None: run_notes(eng, store, ws, sids, a, op),
    "event_draft": lambda eng, store, ws, sids, a, op=None: run_event(eng, store, ws, sids[0], a, op),
}
SOURCES = {"classify": 1, "study_note": 3, "event_draft": 1}


def sources(eng, store, ws, kind, *, consent=True):
    return [upload(eng, store, ws, (10 * i + 1, 2, 3), consent=consent) for i in range(SOURCES[kind])]


# ----------------------------------------------------------------- 1. granted
@pytest.mark.parametrize("kind", list(WORKERS))
def test_granted_consent_dispatches_once_and_saves(world, kind):
    eng, store, (ws, _) = world
    sids = sources(eng, store, ws, kind)
    a = Recording()
    op = WORKERS[kind](eng, store, ws, sids, a)
    assert a.calls == 1
    assert op_state(eng, op)[0] in {"successful", "uncertain"}
    assert counts(eng)["artifacts"] >= 1
    assert dispatch_rows(eng, op) == [(sid, "completed", 0) for sid in sids]
    assert a.in_transaction == [False]  # no transaction held across the adapter call


# ----------------------------------------------------------------- 2. missing consent
@pytest.mark.parametrize("kind", list(WORKERS))
def test_missing_consent_never_dispatches(world, kind):
    eng, store, (ws, _) = world
    sids = sources(eng, store, ws, kind, consent=False)
    a = Recording()
    op = WORKERS[kind](eng, store, ws, sids, a)
    assert a.calls == 0
    assert op_state(eng, op) == ("failed", CONSENT_REQUIRED)
    assert dispatch_rows(eng, op) == [] and counts(eng)["artifacts"] == 0


# ----------------------------------------------------------------- 3. withdrawn before dispatch
@pytest.mark.parametrize("kind", list(WORKERS))
def test_withdrawal_after_the_early_check_but_before_dispatch_blocks_the_call(world, kind, monkeypatch):
    """Withdrawn while the originals are being read (after the early check)."""
    eng, store, (ws, _) = world
    sids = sources(eng, store, ws, kind)
    real = VaultService.read_original
    fired = {"n": 0}

    def read_then_withdraw(self, sid):
        out = real(self, sid)
        fired["n"] += 1
        if fired["n"] == len(sids):  # after the LAST read, i.e. just before authorization
            set_consent_elsewhere(eng, ws, sids[-1], False)
        return out

    monkeypatch.setattr(VaultService, "read_original", read_then_withdraw)
    a = Recording()
    op = WORKERS[kind](eng, store, ws, sids, a)
    assert a.calls == 0
    assert op_state(eng, op) == ("failed", CONSENT_REQUIRED)
    assert dispatch_rows(eng, op) == [] and counts(eng)["artifacts"] == 0


# ----------------------------------------------------------------- 4. racing withdrawal
@pytest.mark.parametrize("kind", list(WORKERS))
def test_a_withdrawal_racing_the_authorization_waits_for_it_and_the_result_is_discarded(world, kind, monkeypatch):
    """The withdrawal starts while authorization holds the workspace lock. It
    cannot interleave: it blocks until authorization commits, so the request
    counts as sent; the withdrawal then commits before the result is saved and
    the result is discarded."""
    eng, store, (ws, _) = world
    sids = sources(eng, store, ws, kind)
    real = WorkspaceRepository.get_consents_fresh
    seen: dict = {}

    def read_while_a_withdrawal_waits(self, ids):
        if "thread" not in seen:
            t = threading.Thread(target=lambda: set_consent_elsewhere(eng, ws, sids[0], False))
            t.start()
            t.join(timeout=0.5)
            seen["blocked"] = t.is_alive()
            seen["thread"] = t
        return real(self, ids)

    monkeypatch.setattr(WorkspaceRepository, "get_consents_fresh", read_while_a_withdrawal_waits)

    def wait_for_withdrawal():
        seen["thread"].join(timeout=10)
        seen["finished_before_result"] = not seen["thread"].is_alive()

    a = Recording(on_enter=wait_for_withdrawal)
    op = WORKERS[kind](eng, store, ws, sids, a)
    assert seen["blocked"] is True               # serialized behind the authorization
    assert seen["finished_before_result"] is True
    assert a.calls == 1                          # authorized first: treated as sent
    assert op_state(eng, op) == ("failed", CONSENT_REQUIRED)
    assert counts(eng)["artifacts"] == 0         # nothing saved from it
    assert [r[1] for r in dispatch_rows(eng, op)] == ["discarded"] * len(sids)


@pytest.mark.parametrize("kind", list(WORKERS))
@pytest.mark.parametrize("regrant", [False, True])
def test_withdrawal_while_in_flight_is_never_saved_even_after_a_regrant(world, kind, regrant):
    eng, store, (ws, _) = world
    sids = sources(eng, store, ws, kind)

    def change():
        set_consent_elsewhere(eng, ws, sids[-1], False)  # a real second connection: no lock is held
        if regrant:
            set_consent_elsewhere(eng, ws, sids[-1], True)

    a = Recording(on_enter=change)
    op = WORKERS[kind](eng, store, ws, sids, a)
    assert a.calls == 1 and a.in_transaction == [False]
    assert op_state(eng, op) == ("failed", CONSENT_REQUIRED)
    assert counts(eng)["artifacts"] == 0
    assert [r[1] for r in dispatch_rows(eng, op)] == ["discarded"] * len(sids)


def test_nothing_writes_between_authorization_and_the_adapter_call(world):
    eng, store, (ws, _) = world
    sid = upload(eng, store, ws, (9, 9, 9))
    log: list[str] = []
    event.listen(eng, "commit", lambda conn: log.append("commit"))
    real = AIDispatchService.authorize

    def marked(self, *args, **kw):
        out = real(self, *args, **kw)
        log.append("authorized")
        return out

    a = Recording(on_enter=lambda: log.append("adapter"))
    import unittest.mock as m
    with m.patch.object(AIDispatchService, "authorize", marked):
        run_classify(eng, store, ws, sid, a)
    i = log.index("authorized")
    assert log[i + 1] == "adapter"  # no commit (no database write) in between


# ----------------------------------------------------------------- 5. wrong workspace / screenshot
@pytest.mark.parametrize("kind", list(WORKERS))
def test_foreign_screenshot_never_dispatches(world, kind):
    eng, store, (ws, other) = world
    foreign = sources(eng, store, other, kind)  # consent granted in ITS workspace
    a = Recording()
    op = WORKERS[kind](eng, store, ws, foreign, a)
    assert a.calls == 0
    # Study Notes rejects a foreign selection even earlier (selection policy).
    assert op_state(eng, op) == ("failed", "Invalid selection" if kind == "study_note" else "Not found")
    assert dispatch_rows(eng, op) == []


def test_authorization_rejects_a_foreign_operation_and_bad_ids(world):
    eng, store, (ws, other) = world
    sid = upload(eng, store, ws, (4, 4, 4))
    foreign_op = pending(eng, other, "classify")
    with Session(eng) as s:
        svc = AIDispatchService(s, ws)
        for op, ids in ((foreign_op, [sid]), (pending(eng, ws, "classify"), []), (pending(eng, ws, "classify"), [sid, sid]),
                        (pending(eng, ws, "classify"), [True]), (pending(eng, ws, "classify"), [-1])):
            with pytest.raises(dispatch_mod.DispatchNotFoundError):
                svc.authorize(op, ids)
    with Session(eng) as s:
        assert s.scalar(select(func.count()).select_from(models.AIDispatch)) == 0


def test_a_partially_foreign_multi_source_selection_dispatches_nothing(world):
    eng, store, (ws, other) = world
    mine = [upload(eng, store, ws, (i + 1, 1, 1)) for i in range(2)]
    foreign = upload(eng, store, other, (50, 1, 1))
    with Session(eng) as s:
        with pytest.raises(dispatch_mod.DispatchNotFoundError):
            AIDispatchService(s, ws).authorize(pending(eng, ws, "study_note"), [*mine, foreign])
    with Session(eng) as s:
        assert s.scalar(select(func.count()).select_from(models.AIDispatch)) == 0


# ----------------------------------------------------------------- 6. failed consent validation
@pytest.mark.parametrize("kind", list(WORKERS))
def test_consent_unreadable_at_dispatch_fails_closed(world, kind, monkeypatch):
    eng, store, (ws, _) = world
    sids = sources(eng, store, ws, kind)

    def broken(self, ids):
        raise OperationalError("select", {}, Exception("disk I/O error"))

    monkeypatch.setattr(WorkspaceRepository, "get_consents_fresh", broken)
    a = Recording()
    op = WORKERS[kind](eng, store, ws, sids, a)
    assert a.calls == 0
    assert op_state(eng, op) == ("failed", "AI processing unavailable")
    assert dispatch_rows(eng, op) == []


def test_classification_early_check_unavailable_fails_closed(world, monkeypatch):
    """The Classification worker now handles an unreadable consent like the others."""
    eng, store, (ws, _) = world
    sid = upload(eng, store, ws, (6, 6, 6))

    def broken(self, sid):
        raise OperationalError("select", {}, Exception("disk I/O error"))

    monkeypatch.setattr(WorkspaceRepository, "get_consent", broken)
    a = Recording()
    op = run_classify(eng, store, ws, sid, a)
    assert a.calls == 0 and op_state(eng, op) == ("failed", "AI processing unavailable")


# ----------------------------------------------------------------- 7. duplicates and retries
@pytest.mark.parametrize("kind", list(WORKERS))
def test_a_repeated_worker_for_the_same_operation_never_dispatches_again(world, kind):
    eng, store, (ws, _) = world
    sids = sources(eng, store, ws, kind)
    a = Recording()
    op = WORKERS[kind](eng, store, ws, sids, a)
    before = (op_state(eng, op), counts(eng), dispatch_rows(eng, op))
    WORKERS[kind](eng, store, ws, sids, a, op)
    assert a.calls == 1
    assert (op_state(eng, op), counts(eng), dispatch_rows(eng, op)) == before


@pytest.mark.parametrize("kind", list(WORKERS))
def test_a_duplicate_worker_that_finds_a_dispatch_already_recorded_backs_off(world, kind):
    """Another worker for the SAME pending operation has already dispatched it
    (its row is recorded, it has not finished). This one must not call the
    adapter and must not change the operation."""
    eng, store, (ws, _) = world
    sids = sources(eng, store, ws, kind)
    op = pending(eng, ws, kind)
    with Session(eng) as s:
        AIDispatchService(s, ws).authorize(op, sids)
    a = Recording()
    WORKERS[kind](eng, store, ws, sids, a, op)
    assert a.calls == 0
    assert op_state(eng, op) == ("pending", None)
    assert [r[1] for r in dispatch_rows(eng, op)] == ["dispatched"] * len(sids)


def test_concurrent_duplicate_authorization_is_rejected_by_the_database(world, monkeypatch):
    """Even if the pending/dispatched pre-check were bypassed, UNIQUE(operation_id,
    screenshot_id) stops a second dispatch row for the same operation."""
    eng, store, (ws, _) = world
    sid = upload(eng, store, ws, (8, 8, 8))
    op = pending(eng, ws, "classify")
    with Session(eng) as s:
        AIDispatchService(s, ws).authorize(op, [sid])
    monkeypatch.setattr(WorkspaceRepository, "list_dispatches", lambda self, op_id: [])
    with Session(eng) as s:
        with pytest.raises(dispatch_mod.DispatchSupersededError):
            AIDispatchService(s, ws).authorize(op, [sid])
    assert len(dispatch_rows(eng, op)) == 1


def test_a_retry_is_a_new_operation_and_is_checked_afresh(world):
    eng, store, (ws, _) = world
    sid = upload(eng, store, ws, (7, 7, 7))
    set_consent_elsewhere(eng, ws, sid, False)
    first = run_classify(eng, store, ws, sid, Recording())
    assert op_state(eng, first) == ("failed", CONSENT_REQUIRED)
    set_consent_elsewhere(eng, ws, sid, True)
    a = Recording()
    second = run_classify(eng, store, ws, sid, a)
    assert a.calls == 1 and op_state(eng, second)[0] in {"successful", "uncertain"}
    assert dispatch_rows(eng, second) == [(sid, "completed", 2)]  # granted, withdrawn, granted


# ----------------------------------------------------------------- Redo paths
def _existing_analysis(eng, store, ws):
    sid = upload(eng, store, ws, (3, 3, 3))
    run_classify(eng, store, ws, sid, Recording())
    return sid


def test_classification_redo_withdrawn_in_flight_keeps_prior_versions(world):
    eng, store, (ws, _) = world
    sid = _existing_analysis(eng, store, ws)
    before = counts(eng)
    op = pending(eng, ws, "redo")
    a = Recording(on_enter=lambda: set_consent_elsewhere(eng, ws, sid, False))
    with Session(eng) as s:
        a.session = s
        ClassificationService(s, ws, adapter=a, vault=VaultService(s, ws, file_store=store)).run_redo(sid, op, "shorter")
    assert a.calls == 1
    assert op_state(eng, op) == ("failed", CONSENT_REQUIRED)
    assert counts(eng) == before


def test_study_note_redo_withdrawn_before_dispatch_never_calls(world, monkeypatch):
    eng, store, (ws, _) = world
    sids = [upload(eng, store, ws, (i + 20, 1, 1)) for i in range(2)]
    run_notes(eng, store, ws, sids, Recording())
    with Session(eng) as s:
        art = s.scalars(select(models.Artifact).where(models.Artifact.kind == "study_note")).one().id
    before = counts(eng)
    op = pending(eng, ws, "redo")
    real = VaultService.read_original
    n = {"i": 0}

    def read_then_withdraw(self, sid):
        out = real(self, sid)
        n["i"] += 1
        if n["i"] == len(sids):
            set_consent_elsewhere(eng, ws, sids[0], False)
        return out

    monkeypatch.setattr(VaultService, "read_original", read_then_withdraw)
    a = Recording()
    with Session(eng) as s:
        StudyNoteService(s, ws, adapter=a, vault=VaultService(s, ws, file_store=store)).run_redo(art, op, None)
    assert a.calls == 0
    assert op_state(eng, op) == ("failed", CONSENT_REQUIRED)
    assert counts(eng) == before


def test_withdrawal_takes_the_same_workspace_lock(world):
    """A consent write issued while another connection holds the workspace lock waits."""
    eng, store, (ws, _) = world
    sid = upload(eng, store, ws, (5, 5, 5))
    with Session(eng) as holder:
        WorkspaceRepository(holder, ws).lock_workspace()
        t = threading.Thread(target=lambda: set_consent_elsewhere(eng, ws, sid, False))
        t.start()
        t.join(timeout=0.5)
        assert t.is_alive()  # blocked behind the lock
        holder.rollback()
    t.join(timeout=10)
    assert not t.is_alive()
    with Session(eng) as s:
        rec = s.scalars(select(models.ConsentRecord).where(models.ConsentRecord.screenshot_id == sid)).one()
        assert (rec.granted, rec.version) == (False, 1)


def test_existing_rows_get_consent_version_zero_from_the_migration(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config
    from pathlib import Path

    backend = Path(__file__).resolve().parent.parent
    url = f"sqlite:///{(tmp_path / 'm.db').as_posix()}"
    monkeypatch.setenv("DATABASE_URL", url)
    cfg = Config(str(backend / "alembic.ini"))
    cfg.set_main_option("script_location", str(backend / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "b5a1c0de0001")
    e = create_engine(url)
    with e.begin() as c:
        c.execute(text("insert into workspace (id, token_hash, created_at) values (1, :h, CURRENT_TIMESTAMP)"), {"h": "c" * 64})
        c.execute(text("insert into content_blob (id, workspace_id, sha256, byte_size, mime_type, storage_path, created_at) "
                       "values (1, 1, :s, 1, 'image/png', 'x', CURRENT_TIMESTAMP)"), {"s": "d" * 64})
        c.execute(text("insert into screenshot (id, workspace_id, content_blob_id, original_filename, state, uploaded_at) "
                       "values (1, 1, 1, 'a.png', 'active', CURRENT_TIMESTAMP)"))
        c.execute(text("insert into consent_record (id, workspace_id, screenshot_id, granted) values (1, 1, 1, 1)"))
    command.upgrade(cfg, "head")
    with e.connect() as c:
        assert c.execute(text("select granted, version from consent_record")).one() == (1, 0)
        assert c.execute(text("select count(*) from ai_dispatch")).scalar() == 0
    command.downgrade(cfg, "b5a1c0de0001")
    with e.connect() as c:
        assert c.execute(text("select granted from consent_record")).scalar() == 1


def test_consent_writes_lock_the_workspace_before_writing(world, monkeypatch):
    """On PostgreSQL the consent UPDATE alone would not wait for an authorization
    holding the workspace row lock; the explicit lock is what orders them. SQLite
    serializes writers anyway, so pin the order of calls."""
    eng, store, (ws, _) = world
    sid = upload(eng, store, ws, (12, 12, 12))
    order: list[str] = []
    real_lock, real_set = WorkspaceRepository.lock_workspace, WorkspaceRepository.set_consent
    monkeypatch.setattr(WorkspaceRepository, "lock_workspace", lambda self: (order.append("lock"), real_lock(self))[1])
    monkeypatch.setattr(WorkspaceRepository, "set_consent", lambda self, **kw: (order.append("set"), real_set(self, **kw))[1])
    set_consent_elsewhere(eng, ws, sid, False)
    assert order == ["lock", "set"]


@pytest.mark.parametrize("kind", list(WORKERS))
def test_an_operation_that_already_ended_is_never_dispatched(world, kind):
    """E.g. the stale-pending sweep failed it while the worker was reading bytes."""
    eng, store, (ws, _) = world
    sids = sources(eng, store, ws, kind)
    op = pending(eng, ws, kind)
    real = VaultService.read_original
    done = {"n": 0}

    def read_then_sweep(self, sid):
        out = real(self, sid)
        done["n"] += 1
        if done["n"] == len(sids):
            with Session(eng) as other:
                OperationService(other, ws).set_terminal_status(op, "failed", error_detail="Processing interrupted; please retry")
        return out

    import unittest.mock as m
    a = Recording()
    with m.patch.object(VaultService, "read_original", read_then_sweep):
        WORKERS[kind](eng, store, ws, sids, a, op)
    assert a.calls == 0
    assert op_state(eng, op) == ("failed", "Processing interrupted; please retry")
    assert dispatch_rows(eng, op) == []


# ----------------------------------------------------------------- provider-scoped consent
def test_a_fake_mode_grant_never_authorizes_a_real_provider(world, monkeypatch):
    """The Fake AI disclosure says nothing is sent. That grant must not authorize
    sending the screenshot to a real provider later; a fresh, informed grant is needed."""
    from app import config

    eng, store, (ws, _) = world
    monkeypatch.setattr(config, "AI_PROVIDER", "fake")
    sid = upload(eng, store, ws, (13, 13, 13))  # granted while the Fake AI was active
    monkeypatch.setattr(config, "AI_PROVIDER", "openai")
    with Session(eng) as s:
        assert ConsentService(s, ws).get_consent(sid).granted is False  # shown as not granted
    a = Recording()
    op = run_classify(eng, store, ws, sid, a)
    assert a.calls == 0 and op_state(eng, op) == ("failed", CONSENT_REQUIRED)
    # An explicit grant while the real provider is active authorizes it.
    set_consent_elsewhere(eng, ws, sid, True)
    with Session(eng) as s:
        rec = s.scalars(select(models.ConsentRecord).where(models.ConsentRecord.screenshot_id == sid)).one()
        assert (rec.granted, rec.provider) == (True, "openai")
    a2 = Recording()
    op2 = run_classify(eng, store, ws, sid, a2)
    assert a2.calls == 1 and op_state(eng, op2)[0] in {"successful", "uncertain"}


def test_a_consent_recorded_before_6a_is_not_valid_for_a_real_provider(world, monkeypatch):
    from app import config

    eng, store, (ws, _) = world
    sid = upload(eng, store, ws, (14, 14, 14))
    with eng.begin() as c:
        c.execute(text("update consent_record set provider = NULL"))  # as the migration leaves old rows
    monkeypatch.setattr(config, "AI_PROVIDER", "openai")
    a = Recording()
    op = run_notes(eng, store, ws, [sid], a)
    assert a.calls == 0 and op_state(eng, op) == ("failed", CONSENT_REQUIRED)
    monkeypatch.setattr(config, "AI_PROVIDER", "fake")  # the Fake AI sends nothing: still fine
    a2 = Recording()
    run_notes(eng, store, ws, [sid], a2)
    assert a2.calls == 1


def test_a_provider_switch_while_in_flight_discards_the_result(world, monkeypatch):
    from app import config

    eng, store, (ws, _) = world
    monkeypatch.setattr(config, "AI_PROVIDER", "openai")
    sid = upload(eng, store, ws, (15, 15, 15))
    # The deployment's provider changes while the request is out: the grant was
    # for "openai", so it no longer covers the configured provider at save time.
    a = Recording(on_enter=lambda: monkeypatch.setattr(config, "AI_PROVIDER", "another-provider"))
    op = run_event(eng, store, ws, sid, a)
    assert a.calls == 1 and op_state(eng, op) == ("failed", CONSENT_REQUIRED)
    assert counts(eng)["artifacts"] == 0
