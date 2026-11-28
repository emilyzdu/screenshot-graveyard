"""Release blockers: the vault must stay inside the STORAGE_ROOT it was created for.

Findings reproduced here (independent review, P1):

* ``.tmp`` symlinked outside the vault (earlier round).
* Codex 1: the STORAGE_ROOT itself renamed away and replaced by a symlink to an
  external directory after ``FileStore`` was created. Reconciliation followed it,
  created an external lock and deleted an external temp file.
* Codex 2: with a shared allocation guard held, ``.tmp`` was renamed and a new
  real ``.tmp`` created; a second, EXCLUSIVE guard was then acquired at the same
  time (two independent lock domains). Reconciliation also re-opened ``.tmp`` by
  pathname for cleanup instead of using the guard's directory handle.

Tests named ``test_codex*`` use only the pre-existing public API
(``allocation_guard()``, ``reclaim_temp_files()``, ``reconcile()``, ...), so they
can be run unchanged against the previous implementation. Disposable
directories and SQLite databases only.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db import models
from app.db.base import Base
from app.preflight import storage_errors
from app.services.global_usage_service import STORAGE_KEY, GlobalUsageService
from app.storage import file_store as fs_mod
from app.storage.file_store import FileStore, StorageBusyError, StorageScanError, UnsafePathError
from app.storage_reconcile import main as reconcile_main
from app.storage_reconcile import reconcile

BACKEND = Path(__file__).resolve().parents[1]
SHA = "a" * 64
# A name that matches the store's own temp-file pattern (what reclaim removes).
OWN_TEMP_NAME = f"{SHA}.4242.{'0' * 16}.tmp"
SENTINEL = b"external sentinel - must survive"
OLD_LOCK_NAME = ".allocation.lock"  # the former lock file; nothing may create it anywhere now


# ---------------------------------------------------------------- helpers
def _db(tmp_path: Path, *, counter: int = 777):
    url = f"sqlite:///{tmp_path / 'containment.db'}"
    eng = create_engine(url, connect_args={"check_same_thread": False}, poolclass=NullPool)
    Base.metadata.create_all(eng)
    with Session(eng) as s:
        s.add(models.GlobalCounter(name=STORAGE_KEY, value=counter))
        s.commit()
    return eng, url


def _counter(eng) -> int:
    with Session(eng) as s:
        return GlobalUsageService(s).storage_used()


def _tree(path: Path) -> dict[str, tuple]:
    """Complete lstat snapshot (kind, content or link target, mtime, mode) of a directory tree."""
    out: dict[str, tuple] = {}
    for dirpath, dirnames, filenames in os.walk(path):
        for name in [*dirnames, *filenames]:
            p = Path(dirpath) / name
            st = os.lstat(p)
            rel = str(p.relative_to(path))
            if stat.S_ISLNK(st.st_mode):
                out[rel] = ("link", os.readlink(p), st.st_mtime_ns)
            elif stat.S_ISDIR(st.st_mode):
                out[rel] = ("dir", stat.S_IMODE(st.st_mode), st.st_mtime_ns)
            else:
                out[rel] = ("file", p.read_bytes(), st.st_mtime_ns, stat.S_IMODE(st.st_mode))
    out["."] = ("dir", stat.S_IMODE(os.lstat(path).st_mode), os.lstat(path).st_mtime_ns)
    return out


def _assert_untouched(path: Path, before: dict[str, tuple]) -> None:
    assert _tree(path) == before, "files or directories outside the vault were created, removed or modified"
    assert not any(p.name == OLD_LOCK_NAME for p in path.rglob("*")), "a lock file was created outside the vault"


def _external(tmp_path: Path, name: str = "outside") -> Path:
    """An external directory laid out like a vault, holding sentinels reclaim/sweep would delete."""
    ext = tmp_path / name
    (ext / ".tmp").mkdir(parents=True, mode=0o755)
    (ext / ".tmp" / OWN_TEMP_NAME).write_bytes(SENTINEL)
    (ext / ".tmp" / "unrelated.txt").write_bytes(SENTINEL)
    (ext / "7" / "ab" / "cd").mkdir(parents=True)
    (ext / "7" / "ab" / "cd" / ("f" * 64)).write_bytes(SENTINEL)
    old = 1_000_000.0  # stale enough for any sweep
    for p in [*ext.rglob("*")]:
        os.utime(p, (old, old), follow_symlinks=False)
    os.chmod(ext, 0o755)
    return ext


def _vault(tmp_path: Path) -> tuple[Path, FileStore]:
    root = tmp_path / "vault"
    store = FileStore(str(root))
    data = b"a real published original"
    store.write_once(1, hashlib.sha256(data).hexdigest(), data)
    (root / ".tmp" / OWN_TEMP_NAME).write_bytes(b"ours")  # this store's own leftover temp file
    return root, store


def _replace_root(root: Path, external: Path, how: str) -> Path:
    """Rename the vault away and put something else at its path; returns what the path now reaches."""
    os.rename(root, root.with_name(root.name + "-moved"))
    if how == "symlink":
        os.symlink(external, root)
        return external
    if how == "directory":
        shutil.copytree(external, root, symlinks=True)
        return root
    assert how == "removed"
    return root


def _swap_tmp(root: Path, content: bytes = SENTINEL) -> None:
    """Rename .tmp aside and create a new real .tmp holding a temp-file sentinel."""
    os.rename(root / ".tmp", root / ".tmp-old")
    (root / ".tmp").mkdir(mode=0o700)
    (root / ".tmp" / OWN_TEMP_NAME).write_bytes(content)


def _open_fds() -> int:
    for d in ("/dev/fd", "/proc/self/fd"):
        if os.path.isdir(d):
            return len(os.listdir(d))
    pytest.skip("cannot count open file descriptors on this platform")


# ================================================================== earlier finding: .tmp symlinked outside
@pytest.fixture
def escaped(tmp_path):
    """STORAGE_ROOT whose .tmp is a symlink to an outside directory holding sentinels."""
    root = tmp_path / "vault"
    root.mkdir()
    outside = _external(tmp_path)
    try:
        os.symlink(outside / ".tmp", root / ".tmp")
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not supported on this platform")
    return root, outside, _tree(outside)


def test_reconcile_refuses_symlinked_tmp_and_leaves_outside_untouched(escaped, tmp_path):
    root, outside, before = escaped
    eng, _ = _db(tmp_path)
    with Session(eng) as s:
        with pytest.raises(UnsafePathError):
            reconcile(session=s, store=FileStore(str(root)))
    _assert_untouched(outside, before)
    assert _counter(eng) == 777  # fail closed: the counter keeps its previous value
    eng.dispose()


def test_reconcile_main_exits_nonzero_without_touching_outside(escaped, tmp_path, monkeypatch, capsys):
    root, outside, before = escaped
    eng, _ = _db(tmp_path)
    import app.storage_reconcile as rec

    monkeypatch.setattr(rec.config, "STORAGE_ROOT", str(root))
    monkeypatch.setattr(rec, "get_session", lambda: Session(eng))
    assert reconcile_main() == 1
    err = capsys.readouterr().err
    assert "Storage reconciliation aborted" in err and str(tmp_path) not in err  # no absolute paths leaked
    _assert_untouched(outside, before)
    assert _counter(eng) == 777
    eng.dispose()


@pytest.mark.parametrize("exclusive", [False, True])
def test_allocation_guard_refuses_symlinked_tmp(escaped, exclusive):
    root, outside, before = escaped
    with pytest.raises(UnsafePathError):
        with FileStore(str(root)).allocation_guard(exclusive=exclusive, wait=False):
            pass
    _assert_untouched(outside, before)


def test_reclaim_and_sweep_refuse_symlinked_tmp(escaped):
    root, outside, before = escaped
    store = FileStore(str(root))
    with pytest.raises(UnsafePathError):
        store.reclaim_temp_files()
    with pytest.raises(UnsafePathError):
        store.sweep_stale_temp_files(older_than_seconds=1.0)
    _assert_untouched(outside, before)


def test_write_once_refuses_symlinked_tmp_before_any_mutation(escaped):
    root, outside, before = escaped
    data = b"x" * 32
    with pytest.raises(UnsafePathError):
        FileStore(str(root)).write_once(1, hashlib.sha256(data).hexdigest(), data)
    _assert_untouched(outside, before)


def test_preflight_rejects_symlinked_tmp_without_writing_outside(escaped):
    root, outside, before = escaped
    errors = storage_errors(str(root), ismount=lambda p: os.path.realpath(p) == os.path.realpath(root))
    assert errors and ".tmp" in errors[0]
    _assert_untouched(outside, before)


def test_tmp_on_another_filesystem_is_refused(tmp_path, monkeypatch):
    """A bind-mounted .tmp (not a symlink, but a different device) is out of root."""
    root = tmp_path / "vault"
    (root / ".tmp").mkdir(parents=True)
    store = FileStore(str(root))
    real_fstat = os.fstat
    tmp_ino = os.stat(root / ".tmp").st_ino

    class _Other:
        def __init__(self, st):
            self._st = st

        def __getattr__(self, name):
            return self._st.st_dev + 1 if name == "st_dev" else getattr(self._st, name)

    monkeypatch.setattr(fs_mod.os, "fstat", lambda fd: _Other(real_fstat(fd)) if real_fstat(fd).st_ino == tmp_ino else real_fstat(fd))
    with pytest.raises(UnsafePathError):
        store.reclaim_temp_files()
    with pytest.raises(UnsafePathError):
        with store.allocation_guard(wait=False):
            pass


def test_tmp_swapped_for_symlink_after_open_cannot_redirect_reclaim(tmp_path):
    """TOCTOU: once .tmp is opened, replacing the name with a symlink changes nothing."""
    root = tmp_path / "vault"
    tmp = root / ".tmp"
    tmp.mkdir(parents=True)
    (tmp / OWN_TEMP_NAME).write_bytes(b"ours")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / OWN_TEMP_NAME).write_bytes(SENTINEL)
    store = FileStore(str(root))
    real_scandir = os.scandir
    swapped = {}

    def swap_then_scan(fd):
        if not swapped:  # the attacker swaps .tmp between the open and the scan
            os.rename(tmp, root / ".tmp-orig")
            os.symlink(outside, tmp)
            swapped["done"] = True
        return real_scandir(fd)

    os_scandir = fs_mod.os.scandir
    fs_mod.os.scandir = swap_then_scan
    try:
        files, _ = store.reclaim_temp_files()
    finally:
        fs_mod.os.scandir = os_scandir
    assert files == 1
    assert (outside / OWN_TEMP_NAME).read_bytes() == SENTINEL  # outside untouched
    assert not (root / ".tmp-orig" / OWN_TEMP_NAME).exists()    # the real temp was reclaimed


# ================================================================== Codex 1: STORAGE_ROOT replaced after FileStore creation
REPLACEMENTS = ["symlink", "directory", "removed"]


@pytest.mark.parametrize("how", REPLACEMENTS)
def test_codex1_reconcile_refuses_a_replaced_storage_root(tmp_path, how):
    root, store = _vault(tmp_path)  # FileStore exists (and has pinned the root) before the swap
    external = _external(tmp_path)
    eng, _ = _db(tmp_path)
    reached = _replace_root(root, external, how)
    before = _tree(reached) if how != "removed" else None
    moved_before = _tree(root.with_name("vault-moved"))
    with Session(eng) as s:
        with pytest.raises(UnsafePathError):
            reconcile(session=s, store=store)
    if before is not None:
        _assert_untouched(reached, before)        # no external lock, sentinel files and permissions intact
    else:
        assert not root.exists()                  # a vanished root is never silently re-created
    assert _tree(root.with_name("vault-moved")) == moved_before  # the real vault was not touched either
    assert _counter(eng) == 777                   # fail closed: the counter keeps its previous value
    eng.dispose()


def test_codex1_main_exits_nonzero_when_the_root_is_replaced_after_store_creation(tmp_path, monkeypatch, capsys):
    root, _ = _vault(tmp_path)
    external = _external(tmp_path)
    eng, _ = _db(tmp_path)
    import app.storage_reconcile as rec

    real_cls = rec.FileStore

    def store_then_swap(root_arg):
        store = real_cls(root_arg)           # pins the real root...
        _replace_root(root, external, "symlink")  # ...then the path is replaced before first use
        return store

    before = _tree(external)
    monkeypatch.setattr(rec, "FileStore", store_then_swap)
    monkeypatch.setattr(rec.config, "STORAGE_ROOT", str(root))
    monkeypatch.setattr(rec, "get_session", lambda: Session(eng))
    assert reconcile_main() == 1  # deploy/start.sh (set -e) would stop here: the server never starts
    err = capsys.readouterr().err
    assert "counter unchanged" in err and str(tmp_path) not in err
    _assert_untouched(external, before)
    assert _counter(eng) == 777
    eng.dispose()


@pytest.mark.parametrize("how", REPLACEMENTS)
@pytest.mark.parametrize("entry", ["guard_shared", "guard_exclusive", "reclaim", "sweep", "write_once", "retained", "published"])
def test_codex1_every_entry_point_refuses_a_replaced_root(tmp_path, how, entry):
    root, store = _vault(tmp_path)
    external = _external(tmp_path)
    reached = _replace_root(root, external, how)
    before = _tree(reached) if how != "removed" else None
    data = b"new upload"
    calls = {
        "guard_shared": lambda: store.allocation_guard(wait=False).__enter__(),
        "guard_exclusive": lambda: store.allocation_guard(exclusive=True, wait=False).__enter__(),
        "reclaim": lambda: store.reclaim_temp_files(),
        "sweep": lambda: store.sweep_stale_temp_files(older_than_seconds=1.0),
        "write_once": lambda: store.write_once(7, hashlib.sha256(data).hexdigest(), data),
        "retained": lambda: store.retained_bytes(),
        "published": lambda: store.published_bytes(),
    }
    with pytest.raises(UnsafePathError):
        calls[entry]()
    if before is not None:
        _assert_untouched(reached, before)
    else:
        assert not root.exists()


def test_codex1_reads_never_serve_bytes_from_a_replaced_root(tmp_path):
    data = b"a real published original"
    sha = hashlib.sha256(data).hexdigest()
    root, store = _vault(tmp_path)
    rel = f"1/{sha[:2]}/{sha[2:4]}/{sha}"
    external = tmp_path / "outside"
    (external / rel).parent.mkdir(parents=True)
    (external / rel).write_bytes(data)  # perfectly valid bytes, but not this vault's
    assert store.read(rel) == data and store.exists(rel)
    _replace_root(root, external, "symlink")
    assert store.exists(rel) is False
    with pytest.raises(UnsafePathError):
        store.read(rel)


def test_a_root_created_after_the_store_is_pinned_at_its_first_creation(tmp_path):
    root = tmp_path / "late"
    store = FileStore(str(root))
    assert store.retained_bytes() == 0 and not root.exists()  # nothing to pin, nothing created
    data = b"first"
    store.write_once(1, hashlib.sha256(data).hexdigest(), data)
    external = _external(tmp_path)
    before = _tree(external)
    _replace_root(root, external, "symlink")
    with pytest.raises(UnsafePathError):
        store.write_once(1, hashlib.sha256(b"second").hexdigest(), b"second")
    _assert_untouched(external, before)


def test_a_configured_symlink_to_the_volume_is_resolved_once_and_works(tmp_path):
    real = tmp_path / "volume"
    real.mkdir()
    link = tmp_path / "storage-link"
    os.symlink(real, link)
    store = FileStore(str(link))
    assert store.root == real.resolve()
    data = b"through a configured link"
    rel = store.write_once(1, hashlib.sha256(data).hexdigest(), data)
    assert store.read(rel) == data and (real / rel).read_bytes() == data
    eng, _ = _db(tmp_path, counter=0)
    (real / ".tmp" / OWN_TEMP_NAME).write_bytes(b"leftover")
    with Session(eng) as s:
        assert reconcile(session=s, store=store) == (0, len(data))
    eng.dispose()


# ================================================================== Codex 2: .tmp replacement must not split the lock
def test_codex2_replacing_tmp_cannot_create_a_second_exclusive_domain(tmp_path):
    root, store = _vault(tmp_path)
    with store.allocation_guard():  # an upload is between "reserve" and "write"
        _swap_tmp(root)  # .tmp renamed, a new real .tmp created
        with pytest.raises(StorageBusyError):  # same store
            with store.allocation_guard(exclusive=True, wait=False):
                pass
        with pytest.raises(StorageBusyError):  # an independent participating store
            with FileStore(str(root)).allocation_guard(exclusive=True, wait=False):
                pass
    assert (root / ".tmp" / OWN_TEMP_NAME).read_bytes() == SENTINEL  # reconcile-style cleanup never ran


def test_codex2_recovery_cannot_run_over_an_upload_after_tmp_replacement(tmp_path):
    root, store = _vault(tmp_path)
    eng, _ = _db(tmp_path)
    with store.allocation_guard():
        _swap_tmp(root)
        with Session(eng) as s:
            with pytest.raises(StorageBusyError):
                reconcile(session=s, store=FileStore(str(root)))
    assert (root / ".tmp" / OWN_TEMP_NAME).read_bytes() == SENTINEL
    assert _counter(eng) == 777
    eng.dispose()


HOLDER = textwrap.dedent(
    """
    import sys
    from app.storage.file_store import FileStore
    with FileStore(sys.argv[1]).allocation_guard(exclusive=(sys.argv[2] == "ex")):
        print("READY", flush=True)
        sys.stdin.readline()
    """
)


def _hold(root: Path, mode: str) -> subprocess.Popen:
    env = {k: v for k, v in os.environ.items() if k not in {"APP_ENV", "TRUSTED_ORIGINS"}}
    env["AI_PROVIDER"] = "fake"
    proc = subprocess.Popen([sys.executable, "-c", HOLDER, str(root), mode], cwd=BACKEND, env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout.readline().strip() == "READY", proc.stderr.read()
    return proc


def _release(proc: subprocess.Popen) -> None:
    try:
        proc.stdin.write("\n")
        proc.stdin.flush()
        proc.wait(timeout=30)
    finally:
        if proc.poll() is None:
            proc.kill()


def test_codex2_another_process_holding_the_guard_still_excludes_after_tmp_replacement(tmp_path):
    root, store = _vault(tmp_path)
    proc = _hold(root, "sh")
    try:
        _swap_tmp(root)
        with pytest.raises(StorageBusyError):
            with store.allocation_guard(exclusive=True, wait=False):
                pass
        with pytest.raises(StorageBusyError):
            with FileStore(str(root)).allocation_guard(exclusive=True, wait=False):
                pass
    finally:
        _release(proc)
    with store.allocation_guard(exclusive=True, wait=False):  # released with the holder
        pass


def test_a_planted_or_replaced_lock_file_cannot_bypass_mutual_exclusion(tmp_path):
    root, store = _vault(tmp_path)
    target = tmp_path / "lock-target"
    target.write_bytes(SENTINEL)
    os.symlink(target, root / ".tmp" / OLD_LOCK_NAME)  # a symlink where the old lock file lived
    with store.allocation_guard():
        os.unlink(root / ".tmp" / OLD_LOCK_NAME)
        (root / ".tmp" / OLD_LOCK_NAME).write_bytes(b"")  # and now a fresh regular file
        with pytest.raises(StorageBusyError):
            with FileStore(str(root)).allocation_guard(exclusive=True, wait=False):
                pass
    assert target.read_bytes() == SENTINEL  # the link target was never opened or created through


def test_lock_modes_keep_shared_exclusive_semantics(tmp_path):
    root, store = _vault(tmp_path)
    other = FileStore(str(root))
    with store.allocation_guard(), other.allocation_guard():  # shared + shared
        with pytest.raises(StorageBusyError):
            with FileStore(str(root)).allocation_guard(exclusive=True, wait=False):
                pass
    with store.allocation_guard(exclusive=True):
        with pytest.raises(StorageBusyError):
            with other.allocation_guard(wait=False):
                pass
    with other.allocation_guard(exclusive=True, wait=False):  # all released
        pass


def test_a_waiting_guard_refuses_a_root_replaced_while_it_waited(tmp_path):
    root, holder = _vault(tmp_path)
    waiter = FileStore(str(root))
    outcome: dict[str, BaseException | bool] = {}

    def wait_for_lock():
        try:
            with waiter.allocation_guard(wait=True):
                outcome["entered"] = True
        except BaseException as exc:  # noqa: BLE001 - reported to the main thread
            outcome["exc"] = exc

    with holder.allocation_guard(exclusive=True):
        thread = threading.Thread(target=wait_for_lock)
        thread.start()
        time.sleep(0.3)  # let it block on the lock
        _replace_root(root, _external(tmp_path), "directory")
    thread.join(timeout=15)
    assert not thread.is_alive()
    assert isinstance(outcome.get("exc"), UnsafePathError) and "entered" not in outcome


# ================================================================== guard handles (reconciliation uses them, never a re-opened path)
def test_reconcile_cleans_through_the_guards_tmp_handle(tmp_path, monkeypatch):
    root, store = _vault(tmp_path)
    eng, _ = _db(tmp_path, counter=0)
    seen = {}
    real = FileStore._reclaim_in

    def spy(tmp_fd):
        st = os.fstat(tmp_fd)
        seen["handle"] = (st.st_dev, st.st_ino)
        return real(tmp_fd)

    monkeypatch.setattr(FileStore, "_reclaim_in", staticmethod(spy))
    before_id = (os.stat(root / ".tmp").st_dev, os.stat(root / ".tmp").st_ino)
    with Session(eng) as s:
        reconcile(session=s, store=store)
    assert seen["handle"] == before_id
    assert not (root / ".tmp" / OWN_TEMP_NAME).exists()  # and it really cleaned that directory
    eng.dispose()


def test_codex2_reconcile_never_reopens_a_replaced_tmp_for_cleanup(tmp_path, monkeypatch):
    root, store = _vault(tmp_path)
    eng, _ = _db(tmp_path)
    real = FileStore.retained_bytes
    calls = {"n": 0}

    def swap_after_first_scan(self, *args, **kwargs):  # API-agnostic: also runs on the old implementation
        total = real(self, *args, **kwargs)
        calls["n"] += 1
        if calls["n"] == 1:  # between the readability scan and the cleanup, inside the guard
            _swap_tmp(root)
        return total

    monkeypatch.setattr(FileStore, "retained_bytes", swap_after_first_scan)
    with Session(eng) as s:
        with pytest.raises(UnsafePathError):
            reconcile(session=s, store=store)
    assert (root / ".tmp" / OWN_TEMP_NAME).read_bytes() == SENTINEL   # the replacement was not cleaned
    assert (root / ".tmp-old" / OWN_TEMP_NAME).read_bytes() == b"ours"  # nor was the original: nothing ran
    assert _counter(eng) == 777
    eng.dispose()


def test_guarded_operations_refuse_a_tmp_or_root_replaced_under_the_guard(tmp_path):
    root, store = _vault(tmp_path)
    with store.allocation_guard(exclusive=True, wait=False) as guard:
        guard.verify()
        _swap_tmp(root)
        for op in (guard.verify, lambda: store.reclaim_temp_files(guard=guard), lambda: store.retained_bytes(guard=guard),
                   lambda: store.published_bytes(guard=guard)):
            with pytest.raises(UnsafePathError):
                op()
    assert (root / ".tmp" / OWN_TEMP_NAME).read_bytes() == SENTINEL

    root2, store2 = _vault(tmp_path / "second")
    external = _external(tmp_path, "outside2")
    before = _tree(external)
    with store2.allocation_guard(exclusive=True, wait=False) as guard:
        _replace_root(root2, external, "symlink")
        with pytest.raises(UnsafePathError):
            guard.verify()
        with pytest.raises(UnsafePathError):
            store2.reclaim_temp_files(guard=guard)
    _assert_untouched(external, before)  # leaving the guard never raises and never touches the outside


def test_a_guard_cannot_be_used_with_a_different_store(tmp_path):
    _, a = _vault(tmp_path / "a")
    _, b = _vault(tmp_path / "b")
    with a.allocation_guard(exclusive=True, wait=False) as guard:
        with pytest.raises(ValueError):
            b.reclaim_temp_files(guard=guard)


def test_guards_release_every_descriptor_on_success_and_on_refusal(tmp_path):
    root, store = _vault(tmp_path)
    store.write_once(2, hashlib.sha256(b"warm").hexdigest(), b"warm")  # warm any lazy imports
    with store.allocation_guard():
        pass
    base = _open_fds()
    for _ in range(25):
        with store.allocation_guard(exclusive=True, wait=False) as guard:
            store.reclaim_temp_files(guard=guard)
            store.retained_bytes(guard=guard)
    with store.allocation_guard():
        for _ in range(25):
            with pytest.raises(StorageBusyError):
                with store.allocation_guard(exclusive=True, wait=False):
                    pass
    _replace_root(root, _external(tmp_path), "symlink")
    for _ in range(25):
        with pytest.raises(UnsafePathError):
            with store.allocation_guard(wait=False):
                pass
    assert _open_fds() == base


# ================================================================== Codex 3: the guarded byte scan must use the guard's .tmp handle
KEPT = b"k" * 100                      # an unknown file in .tmp: kept by reclaim, counted by the scan
ORIGINAL = b"a real published original"  # what _vault() publishes


def _interleave(monkeypatch, root: Path, kind: str, arm_scan: int, tmp_path: Path) -> dict:
    """Codex's interleaving, API-agnostic (runs on the previous implementation too).

    For the ``arm_scan``-th ``retained_bytes`` call, a substitute ``.tmp`` is put in place right after the
    scan's opening ``guard.verify()`` and the original is restored right before its closing ``guard.verify()``:
    every pathname use of ``.tmp`` during the scan sees the substitute, both verifications see the original.
    """
    state = {"scan": 0, "v": 0, "swapped": False, "restored": False}
    aside = tmp_path / "original-tmp-parked"  # OUTSIDE the vault: a parked copy inside it would be scanned too
    empty_external = tmp_path / "empty-external"

    def swap():
        os.rename(root / ".tmp", aside)
        if kind == "empty-dir":            # Codex's exact case: an empty directory takes its place
            (root / ".tmp").mkdir(mode=0o700)
        elif kind == "symlink":            # a symlink to an empty directory
            empty_external.mkdir(exist_ok=True)
            os.symlink(empty_external, root / ".tmp")
        state["swapped"] = True            # kind == "absent": the name simply vanishes for a moment

    def restore():
        if kind == "empty-dir":
            os.rmdir(root / ".tmp")
        elif kind == "symlink":
            os.unlink(root / ".tmp")
        os.rename(aside, root / ".tmp")
        state["restored"] = True

    real_scan_entry = FileStore.retained_bytes
    real_verify = fs_mod._AllocationGuard.verify

    def retained(self, *args, **kwargs):
        state["scan"] += 1
        state["v"] = 0
        return real_scan_entry(self, *args, **kwargs)

    def verify(self):
        armed = state["scan"] == arm_scan
        state["v"] += 1
        if armed and state["v"] == 2 and state["swapped"] and not state["restored"]:
            restore()                      # immediately before the closing verification
        real_verify(self)
        if armed and state["v"] == 1 and not state["swapped"]:
            swap()                         # immediately after the opening verification

    monkeypatch.setattr(FileStore, "retained_bytes", retained)
    monkeypatch.setattr(fs_mod._AllocationGuard, "verify", verify)
    return state


@pytest.mark.parametrize("kind", ["empty-dir", "absent", "symlink"])
def test_codex3_reconcile_commits_the_true_count_or_fails_closed_when_tmp_is_substituted_mid_scan(tmp_path, monkeypatch, kind):
    root, store = _vault(tmp_path)  # .tmp holds this store's own leftover temp file (reclaimed)
    (root / ".tmp" / "operator-notes.txt").write_bytes(KEPT)
    expected = len(ORIGINAL) + len(KEPT)  # what is really retained once the leftover is reclaimed
    eng, _ = _db(tmp_path)
    state = _interleave(monkeypatch, root, kind, arm_scan=2, tmp_path=tmp_path)  # 2nd scan = the committed count
    try:
        reconcile(session=Session(eng), store=store)
    except (UnsafePathError, StorageScanError):
        assert _counter(eng) == 777, "failed closed but changed the previous counter"
    else:
        assert _counter(eng) == expected, "committed a count that does not match the retained bytes"
    assert state["swapped"] and state["restored"], "the interleaving did not run"
    assert (root / ".tmp" / "operator-notes.txt").read_bytes() == KEPT  # the real .tmp is back, unharmed
    assert not (tmp_path / "original-tmp-parked").exists()
    eng.dispose()


@pytest.mark.parametrize("kind", ["empty-dir", "absent", "symlink"])
def test_codex3_the_guarded_scan_itself_counts_the_guards_tmp_directory(tmp_path, monkeypatch, kind):
    root, store = _vault(tmp_path)
    (root / ".tmp" / "operator-notes.txt").write_bytes(KEPT)
    expected = len(ORIGINAL) + len(b"ours") + len(KEPT)  # nothing reclaimed in this test
    state = _interleave(monkeypatch, root, kind, arm_scan=1, tmp_path=tmp_path)
    with store.allocation_guard(exclusive=True, wait=False) as guard:
        try:
            total = store.retained_bytes(guard=guard)
        except (UnsafePathError, StorageScanError):
            total = None  # failing closed is acceptable; a wrong total is not
    assert total in (None, expected), f"scan returned {total}, expected {expected}"
    assert state["swapped"] and state["restored"]


def test_codex3_a_subdirectory_replaced_between_stat_and_open_is_never_counted_as_empty(tmp_path, monkeypatch):
    """The same descriptor-versus-path gap for directories the guard holds no handle for."""
    root, store = _vault(tmp_path)  # the published original lives under <root>/1/..
    eng, _ = _db(tmp_path)
    hits = {"n": 0, "swapped": False}
    real_open = os.open

    def hooked(path, flags, *args, **kwargs):
        if path == "1" and kwargs.get("dir_fd") is not None and flags & os.O_DIRECTORY:
            hits["n"] += 1
            if hits["n"] == 2:  # the scan whose result reconcile commits
                parked = tmp_path / "original-ws-parked"  # outside the vault, or the scan would count it too
                os.rename(root / "1", parked)
                (root / "1").mkdir()
                try:
                    return real_open(path, flags, *args, **kwargs)
                finally:
                    os.rmdir(root / "1")
                    os.rename(parked, root / "1")
                    hits["swapped"] = True
        return real_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(fs_mod.os, "open", hooked)
    try:
        reconcile(session=Session(eng), store=store)
    except (UnsafePathError, StorageScanError):
        assert _counter(eng) == 777
    else:
        assert _counter(eng) == len(ORIGINAL)  # leftover temp reclaimed; only the original remains
    assert hits["swapped"], "the interleaving did not run"
    eng.dispose()


# ================================================================== failed reconciliation never permits startup
def test_failed_reconcile_keeps_the_counter_and_the_entry_point_refuses_startup(tmp_path):
    root = tmp_path / "vault"
    root.mkdir()
    outside = _external(tmp_path)
    os.symlink(outside / ".tmp", root / ".tmp")
    before = _tree(outside)
    eng, url = _db(tmp_path)
    env = {k: v for k, v in os.environ.items() if k not in {"APP_ENV", "TRUSTED_ORIGINS"}}
    env.update({"DATABASE_URL": url, "STORAGE_ROOT": str(root), "AI_PROVIDER": "fake"})
    r = subprocess.run([sys.executable, "-m", "app.storage_reconcile"], cwd=BACKEND, env=env,
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 1 and "counter unchanged" in r.stderr and "Traceback" not in r.stderr
    assert str(tmp_path) not in r.stderr
    _assert_untouched(outside, before)
    assert _counter(eng) == 777
    eng.dispose()


# ================================================================== normal behaviour still works
def test_normal_reconcile_reclaims_own_temp_and_counts_published(tmp_path):
    root = tmp_path / "vault"
    store = FileStore(str(root))
    data = b"published original bytes"
    rel = store.write_once(3, hashlib.sha256(data).hexdigest(), data)
    (root / ".tmp" / OWN_TEMP_NAME).write_bytes(b"leftover temp")   # ours: reclaimed
    (root / ".tmp" / "operator-notes.txt").write_bytes(b"keep")      # unknown: kept, counted
    eng, _ = _db(tmp_path, counter=0)
    with Session(eng) as s:
        before, after = reconcile(session=s, store=store)
    assert (before, after) == (0, len(data) + len(b"keep"))
    assert _counter(eng) == len(data) + len(b"keep")
    assert not (root / ".tmp" / OWN_TEMP_NAME).exists()
    assert (root / ".tmp" / "operator-notes.txt").exists()
    assert sorted(p.name for p in (root / ".tmp").iterdir()) == ["operator-notes.txt"]  # no lock file anywhere
    assert store.read(rel) == data
    assert stat.S_IMODE(os.stat(root / ".tmp").st_mode) == 0o700
    # Idempotent: a second run reclaims nothing and counts the same.
    with Session(eng) as s:
        assert reconcile(session=s, store=FileStore(str(root))) == (after, after)
    eng.dispose()


def test_fresh_store_creates_private_tmp_and_publishes_read_only(tmp_path):
    root = tmp_path / "fresh"
    store = FileStore(str(root))
    with store.allocation_guard(exclusive=True, wait=False):
        pass
    assert (root / ".tmp").is_dir() and not (root / ".tmp").is_symlink()
    assert stat.S_IMODE(os.stat(root / ".tmp").st_mode) == 0o700
    data = b"first upload"
    rel = store.write_once(1, hashlib.sha256(data).hexdigest(), data)
    assert store.read(rel) == data
    assert stat.S_IMODE(os.stat(root / rel).st_mode) == 0o444
    assert list((root / ".tmp").iterdir()) == []  # no temp and no lock file left


def test_upload_through_the_vault_service_then_reconcile(tmp_path, monkeypatch):
    from app import config
    from app.services.vault_service import VaultService
    from tests.test_deploy_final import _db as ws_db
    from tests.test_real_provider_integration import png

    root = tmp_path / "store"
    monkeypatch.setattr(config, "STORAGE_ROOT", str(root))
    eng, _, ws = ws_db(tmp_path)
    image = png((120, 4, 4))
    with Session(eng) as s:
        VaultService(s, ws, file_store=FileStore(str(root))).upload(image, filename="a.png")
    sha = hashlib.sha256(image).hexdigest()
    assert (root / str(ws) / sha[:2] / sha[2:4] / sha).read_bytes() == image
    (root / ".tmp" / OWN_TEMP_NAME).write_bytes(b"x" * 10)  # a crashed upload's temp file
    with Session(eng) as s:
        reconcile(session=s, store=FileStore(str(root)))
    assert _counter(eng) == len(image)
    assert not (root / ".tmp" / OWN_TEMP_NAME).exists()
    with Session(eng) as s:  # uploads keep working after reconciliation
        VaultService(s, ws, file_store=FileStore(str(root))).upload(png((121, 4, 4)), filename="b.png")
    eng.dispose()
