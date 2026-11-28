"""Final deployment remediation: P1-2 crash-safe storage accounting, P1-4
build context and verifier fail-closed, P1-5 complete preflight, P2 origins.

Isolated temp filesystems and databases only; synthetic secrets; no live AI.
"""

from __future__ import annotations

import hashlib
import os
import signal
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app import config
from app.db import models
from app.db.base import Base
from app.preflight import preflight_errors
from app.production_checks import production_config_errors
from app.services.global_usage_service import GlobalUsageService
from app.services.vault_service import StorageLimitError, VaultService
from app.storage.file_store import FileStore, StorageBusyError
from app.storage_reconcile import reconcile
from tests.test_deploy_foundation import GOOD
from tests.test_deploy_remediation import (
    REQUIRED,
    SENTINELS,
    _dockerignore_rules,
    _env,
    _excluded,
    _mounted,
)
from tests.test_real_provider_integration import png

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
PY = sys.executable


def _db(tmp_path):
    url = f"sqlite:///{tmp_path / 'c.sqlite'}"
    eng = create_engine(url, connect_args={"check_same_thread": False, "timeout": 20}, poolclass=NullPool)
    Base.metadata.create_all(eng)
    with Session(eng) as s:
        ws = models.Workspace(token_hash="c" * 64)
        s.add(ws)
        s.commit()
        return eng, url, ws.id


def _counter(eng) -> int:
    with Session(eng) as s:
        return GlobalUsageService(s).storage_used()


def _snapshot(root: Path) -> dict[str, str]:
    """Hashes of published originals (everything outside .tmp/)."""
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file() and ".tmp" not in p.parts}


def _all_bytes(root: Path) -> int:
    """Independent physical measure: every regular file, once per inode."""
    seen, total = set(), 0
    for p in root.rglob("*"):
        if p.is_file() and not p.is_symlink():
            st = p.stat()
            if (st.st_dev, st.st_ino) not in seen:
                seen.add((st.st_dev, st.st_ino))
                total += st.st_size
    return total


# ===================================================================== P1-2 crash-safe accounting

CHILD = textwrap.dedent('''
    import os, signal, sys
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from sqlalchemy.pool import NullPool
    from app.services.vault_service import VaultService
    from tests.test_real_provider_integration import png

    def die(*a, **k):                       # killed AFTER the temp file was fsynced,
        os.kill(os.getpid(), signal.SIGKILL)  # BEFORE publication by hard link
    os.link = die
    eng = create_engine(os.environ["DATABASE_URL"], poolclass=NullPool)
    with Session(eng) as s:
        VaultService(s, int(sys.argv[1])).upload(png((77, 7, 7)), filename="killed.png")
    print("NOT KILLED")
''')


def _kill_mid_upload(url: str, root: Path, ws: int) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k not in {"APP_ENV", "TRUSTED_ORIGINS"}}
    env.update({"DATABASE_URL": url, "STORAGE_ROOT": str(root), "AI_PROVIDER": "fake"})
    return subprocess.run([PY, "-c", CHILD, str(ws)], cwd=BACKEND, env=env, capture_output=True, text=True,
                          timeout=120)


def test_p1_2_a_process_killed_after_temp_fsync_is_fully_accounted(tmp_path, monkeypatch):
    root = tmp_path / "store"
    monkeypatch.setattr(config, "STORAGE_ROOT", str(root))
    eng, url, ws = _db(tmp_path)
    with Session(eng) as s:  # an existing original that must stay untouched
        VaultService(s, ws, file_store=FileStore(str(root))).upload(png((76, 6, 6)), filename="kept.png")
    originals = _snapshot(root)

    # 1. Terminate a disposable child after temp-file fsync, before publication.
    child = _kill_mid_upload(url, root, ws)
    assert child.returncode == -signal.SIGKILL, child.stderr[-500:]
    temps = [p for p in (root / ".tmp").iterdir() if p.name.endswith(".tmp")]
    assert len(temps) == 1 and temps[0].stat().st_size == len(png((77, 7, 7)))  # bytes retained on disk

    # 2. Restart and reconcile.
    eng.dispose()
    eng2 = create_engine(url, poolclass=NullPool)
    with Session(eng2) as s:
        reconcile(session=s, store=FileStore(str(root)))
    physical = _all_bytes(root)
    assert _counter(eng2) == physical  # every retained byte is counted (no uncounted temp)
    assert not [p for p in (root / ".tmp").iterdir() if p.name.endswith(".tmp")]

    # 3. Physical retained bytes plus the next accepted upload cannot exceed the cap.
    nxt = png((78, 8, 8))
    cap = physical + len(nxt)
    monkeypatch.setattr(config, "MAX_TOTAL_STORAGE_BYTES", cap)
    with Session(eng2) as s:
        VaultService(s, ws, file_store=FileStore(str(root))).upload(nxt, filename="next.png")
    assert _all_bytes(root) <= cap
    with Session(eng2) as s:
        with pytest.raises(StorageLimitError):
            VaultService(s, ws, file_store=FileStore(str(root))).upload(png((79, 9, 9)), filename="over.png")
    assert _all_bytes(root) <= cap

    # 4. Repeat reconciliation: stable.
    for _ in range(2):
        with Session(eng2) as s:
            before, after = reconcile(session=s, store=FileStore(str(root)))
        assert before == after == _all_bytes(root)
    # 8. Existing originals unchanged.
    snap = _snapshot(root)
    assert {k: snap[k] for k in originals} == originals
    eng2.dispose()


def test_p1_2_metadata_less_published_content_is_accepted_at_the_cap(tmp_path, monkeypatch):
    root = tmp_path / "store"
    monkeypatch.setattr(config, "STORAGE_ROOT", str(root))
    eng, url, ws = _db(tmp_path)
    data = png((80, 1, 1))
    from app.db.repository import WorkspaceRepository

    original = WorkspaceRepository.create_screenshot
    calls = {"n": 0}

    def fail_first(self, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("metadata transaction failed after publication")
        return original(self, **kw)

    monkeypatch.setattr(WorkspaceRepository, "create_screenshot", fail_first)
    with Session(eng) as s:
        with pytest.raises(Exception):
            VaultService(s, ws, file_store=FileStore(str(root))).upload(data, filename="a.png")
    with Session(eng) as s:
        assert list(s.scalars(select(models.ContentBlob))) == []  # published, no metadata
    full = _counter(eng)
    physical = _all_bytes(root)
    monkeypatch.setattr(config, "MAX_TOTAL_STORAGE_BYTES", full)  # exactly full: no room for new bytes
    # 5/6. The retry needs no new bytes and is not refused by the new-byte limit.
    with Session(eng) as s:
        r = VaultService(s, ws, file_store=FileStore(str(root))).upload(data, filename="a.png")
    assert r.screenshot_id and _counter(eng) == full and _all_bytes(root) == physical
    eng.dispose()


def test_p1_2_hard_links_are_counted_once_and_reclaim_never_harms_originals(tmp_path):
    root = tmp_path / "store"
    store = FileStore(str(root))
    data = png((81, 1, 1))
    sha = hashlib.sha256(data).hexdigest()
    rel = store.write_once(5, sha, data)
    final = root / rel
    # A crash after publication but before the temp name was unlinked: two names, one inode.
    leftover = root / ".tmp" / f"{sha}.4242.{'0' * 16}.tmp"
    os.link(final, leftover)
    (root / ".tmp" / "operator-notes.txt").write_text("not ours")  # unknown name: never removed
    assert store.retained_bytes() == len(data) + len("not ours")    # 7. not double-counted
    with store.allocation_guard(exclusive=True):
        files, freed = store.reclaim_temp_files()
    assert (files, freed) == (1, 0)  # a link dropped, no bytes freed
    assert final.read_bytes() == data and os.stat(final).st_nlink == 1
    assert (root / ".tmp" / "operator-notes.txt").exists()
    assert store.retained_bytes() == len(data) + len("not ours")


def test_p1_2_recovery_never_overlaps_an_upload(tmp_path):
    store = FileStore(str(tmp_path / "store"))
    eng, url, ws = _db(tmp_path)
    with store.allocation_guard():  # an upload is between reserve and write
        with Session(eng) as s:
            with pytest.raises(StorageBusyError):
                reconcile(session=s, store=store)
    eng.dispose()


# ===================================================================== P1-4 build context and verifier

FINAL_SENTINELS = [
    "backend/app/cache.sqlite3-wal", "backend/app/cache.sqlite3-shm", "backend/app/cache.sqlite3-journal",
    "backend/app/app.db-journal", "backend/app/dev.local-storage/1/ab/cd/" + "b" * 64,
    "backend/app/storage-dev/blob.bin", "backend/app/uploads/x.png", "frontend/src/assets/local.db",
    "frontend/src/.env.development", "backend/alembic/versions/.env", "frontend/public/secret.pem",
]


@pytest.mark.parametrize("path", FINAL_SENTINELS + SENTINELS)
def test_p1_4_reproduced_paths_and_all_sentinels_are_excluded(path):
    assert _excluded(path, _dockerignore_rules()), path


def _tracked(prefix: str) -> list[str]:
    """Tracked AND new (untracked, not git-ignored) source files under ``prefix``."""
    out = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", prefix],
                         cwd=REPO, capture_output=True, text=True, check=True)
    return [line for line in out.stdout.splitlines() if line and (REPO / line).is_file()]


def test_p1_4_every_tracked_source_file_that_the_build_needs_is_included():
    rules = _dockerignore_rules()
    needed = (_tracked("backend/app") + _tracked("backend/alembic") + _tracked("frontend/src")
              + _tracked("frontend/public"))
    # Tests and documentation are not build or runtime inputs.
    needed = [p for p in needed if not p.endswith((".test.ts", ".test.tsx")) and Path(p).name != "README"]
    # Pixel World source art is provenance, not a runtime input (P1-4b).
    needed = [p for p in needed if not p.startswith("frontend/src/world/assets/_source/")]
    assert "backend/app/storage/file_store.py" in needed
    missing = [p for p in needed if _excluded(p, rules)]
    assert missing == [], missing
    for p in REQUIRED:
        assert not _excluded(p, rules), p


def _fake_docker(tmp_path, behaviour: str) -> Path:
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    script = bindir / "docker"
    script.write_text(textwrap.dedent(f"""\
        #!/bin/sh
        case "$1" in
          build) case "$*" in *"-f -"*) cat >/dev/null ;; esac; [ "{behaviour}" = build-fails ] && exit 1; exit 0 ;;
          image) exit 0 ;;
          run)
            [ "{behaviour}" = run-125 ] && {{ echo "docker: Error response from daemon" >&2; exit 125; }}
            [ "{behaviour}" = leak ] && {{ echo "STATUS=FOUND"; exit 0; }}
            echo "STATUS=CLEAN"; echo "INCLUDED=OK"; exit 0 ;;
        esac
        exit 2
    """))
    script.chmod(0o755)
    return bindir


@pytest.mark.parametrize("behaviour, ok", [
    ("clean", True), ("run-125", False), ("build-fails", False), ("leak", False),
])
def test_p1_4_the_verifier_fails_closed(tmp_path, behaviour, ok):
    """Static: a fake `docker` stands in for the daemon. Proves the script's exit
    logic only; it does NOT verify a real image."""
    bindir = _fake_docker(tmp_path, behaviour)
    env = {"PATH": f"{bindir}:/usr/bin:/bin", "HOME": str(tmp_path)}
    r = subprocess.run(["/bin/sh", str(REPO / "deploy" / "verify-build-context.sh"), str(REPO)],
                       env=env, capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
    assert (r.returncode == 0) is ok, (r.stdout, r.stderr)
    assert ("VERIFIED" in r.stdout) is ok
    if not ok:
        assert "OK:" not in r.stdout or "FAIL" in (r.stdout + r.stderr)


def test_p1_4_the_verifier_plants_the_exact_reproduced_sentinels():
    script = (REPO / "deploy" / "verify-build-context.sh").read_text()
    for path in ("backend/app/cache.sqlite3-wal", "backend/app/cache.sqlite3-shm", "backend/app/dev.local-storage/"):
        assert path in script, path


# ===================================================================== P1-5 complete preflight

@pytest.mark.parametrize("over, fragment", [
    ({"OPENAI_MODEL": ""}, "OPENAI_MODEL"),                      # Codex's reproduction
    ({"OPENAI_MODEL": "   "}, "OPENAI_MODEL"),
    ({"OPENAI_API_KEY": "   "}, "OPENAI_API_KEY"),
    ({"AI_PROVIDER": "gemini"}, "AI_PROVIDER"),
    ({"AI_PROVIDER": " "}, "AI_PROVIDER"),
    ({"OPENAI_REASONING_EFFORT": "ultra"}, "OPENAI_REASONING_EFFORT"),
    ({"AI_ADAPTER_TIMEOUT_SECONDS": "0"}, "AI_ADAPTER_TIMEOUT_SECONDS"),
    ({"AI_PROVIDER_MAX_RETRIES": "2"}, "AI_PROVIDER_MAX_RETRIES"),
    ({"MAX_AI_CALLS_PER_WORKSPACE": "abc"}, "configuration"),
])
def test_p1_5_invalid_provider_settings_fail_preflight(tmp_path, over, fragment):
    env = _env(tmp_path) | over
    errors = preflight_errors(env, ismount=_mounted(tmp_path))
    assert any(fragment in e for e in errors), errors
    joined = " ".join(errors)
    assert "sk-test-NOT-A-REAL-KEY" not in joined and "SECRET-PASSWORD" not in joined


def test_p1_5_a_valid_provider_configuration_passes_and_matches_runtime(tmp_path):
    assert preflight_errors(_env(tmp_path), ismount=_mounted(tmp_path)) == []
    assert preflight_errors(_env(tmp_path, AI_PROVIDER="fake", OPENAI_API_KEY=None), ismount=_mounted(tmp_path)) == []


def test_p1_5_the_real_start_script_never_reaches_alembic_with_a_blank_model(tmp_path):
    """Runs deploy/start.sh with the REAL preflight (a logging wrapper around this
    interpreter). The blank model must stop it before Alembic is invoked."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "calls.log"
    (bindir / "python").write_text(f'#!/bin/sh\necho "$*" >> "{log}"\nexec "{PY}" "$@"\n')
    (bindir / "python").chmod(0o755)
    env = {k: v for k, v in (GOOD | {"STORAGE_ROOT": str(tmp_path / "vol" / "s"), "OPENAI_MODEL": ""}).items()}
    env.update({"PATH": f"{bindir}:/usr/bin:/bin", "APP_HOME": str(REPO), "HOME": str(tmp_path)})
    r = subprocess.run(["/bin/sh", str(REPO / "deploy" / "start.sh")], env=env, capture_output=True, text=True,
                       timeout=180)
    assert r.returncode != 0
    assert "OPENAI_MODEL" in r.stderr
    assert log.read_text().splitlines() == ["-m app.preflight"]  # alembic never ran
    assert "sk-test-NOT-A-REAL-KEY" not in r.stderr + r.stdout and "SECRET-PASSWORD" not in r.stderr + r.stdout


# ===================================================================== P2 origins

@pytest.mark.parametrize("origin", [
    "https://graveyard.example.com/app", "https://graveyard.example.com/?x=1", "https://graveyard.example.com#f",
    "https://user:pw@graveyard.example.com", "https://graveyard.example.com:99999", "https://graveyard.example.com:abc",
    "https://graveyard.example.com:0", "https://*.example.com", "https:///nohost", "graveyard.example.com",
])
def test_p2_origins_that_no_browser_could_send_are_rejected(origin):
    errors = production_config_errors(GOOD | {"TRUSTED_ORIGINS": origin})
    assert any("TRUSTED_ORIGINS" in e for e in errors), (origin, errors)


@pytest.mark.parametrize("origin", ["https://graveyard.example.com", "https://graveyard.example.com:8443",
                                    "https://graveyard.example.com/"])
def test_p2_normal_https_origins_pass(origin):
    assert production_config_errors(GOOD | {"TRUSTED_ORIGINS": origin}) == []


@pytest.mark.parametrize("raw, ok", [
    ("https://a.example.com/path", False), ("http://localhost:5173", True),
    ("https://u:p@a.example.com", False), ("https://a.example.com?q", False),
])
def test_p2_config_rejects_malformed_origins_in_every_environment(raw, ok):
    env = {k: v for k, v in os.environ.items() if k not in {"APP_ENV", "TRUSTED_ORIGINS"}}
    env["TRUSTED_ORIGINS"] = raw
    r = subprocess.run([PY, "-c", "import app.config"], cwd=BACKEND, env=env, capture_output=True, text=True,
                       timeout=60)
    assert (r.returncode == 0) is ok, r.stderr[-300:]


def test_p2_docs_do_not_contradict_no_proxy_headers_or_call_the_quota_a_spending_cap():
    docs = "\n".join((REPO / "docs" / n).read_text() for n in ("deployment-readiness.md", "pixel-world-prd.md",
                                                             "pixel-world-technical-design.md"))
    assert "--proxy-headers --forwarded-allow-ips" not in docs
    for bad in ("Global spending cap", "Global AI spending cap", "global daily AI budget"):
        assert bad not in docs, bad


# ===================================================================== blockers: fail-closed scans

needs_permissions = pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")


def _set_counter(eng, value: int) -> None:
    with Session(eng) as s:
        usage = GlobalUsageService(s)
        usage.reconcile_storage(value)
        s.commit()


@needs_permissions
@pytest.mark.parametrize("mode", [0o000, 0o600], ids=["unlistable", "entries-uninspectable"])
def test_reconcile_aborts_on_an_unreadable_workspace_directory(tmp_path, monkeypatch, mode):
    from app.storage.file_store import StorageScanError

    root = tmp_path / "store"
    monkeypatch.setattr(config, "STORAGE_ROOT", str(root))
    eng, url, ws = _db(tmp_path)
    with Session(eng) as s:
        VaultService(s, ws, file_store=FileStore(str(root))).upload(png((90, 1, 1)), filename="a.png")
    originals = _snapshot(root)
    true_bytes = _all_bytes(root)
    leftover = root / ".tmp" / f"{'d' * 64}.4242.{'0' * 16}.tmp"
    leftover.write_bytes(b"x" * 100)                       # a crashed upload's temp file
    true_bytes += 100
    _set_counter(eng, true_bytes)                          # the previous, correct counter

    ws_dir = root / str(ws)
    original_mode = ws_dir.stat().st_mode & 0o777
    ws_dir.chmod(mode)
    try:
        with Session(eng) as s:
            with pytest.raises(StorageScanError) as info:
                reconcile(session=s, store=FileStore(str(root)))
        assert str(ws) in str(info.value)                  # names the uninspectable path
        assert _counter(eng) == true_bytes                 # never overwritten with a partial scan
        assert leftover.exists()                           # nothing reclaimed before the abort

        # The `python -m app.storage_reconcile` entry point exits non-zero, so
        # deploy/start.sh (set -e) never starts the server on a partial count.
        env = {k: v for k, v in os.environ.items() if k not in {"APP_ENV", "TRUSTED_ORIGINS"}}
        env.update({"DATABASE_URL": url, "STORAGE_ROOT": str(root), "AI_PROVIDER": "fake"})
        r = subprocess.run([PY, "-m", "app.storage_reconcile"], cwd=BACKEND, env=env, capture_output=True,
                           text=True, timeout=120)
        assert r.returncode == 1 and "counter unchanged" in r.stderr and "Traceback" not in r.stderr
        assert _counter(eng) == true_bytes
    finally:
        ws_dir.chmod(original_mode)

    # Originals unchanged; the kept counter still blocks an upload that only an
    # undercount would have allowed.
    snap = _snapshot(root)
    assert {k: snap[k] for k in originals} == originals
    nxt = png((91, 1, 1))
    monkeypatch.setattr(config, "MAX_TOTAL_STORAGE_BYTES", true_bytes + len(nxt) - 1)
    with Session(eng) as s:
        with pytest.raises(StorageLimitError):
            VaultService(s, ws, file_store=FileStore(str(root))).upload(nxt, filename="over.png")
    # Once the directory is readable again, reconciliation completes and is exact.
    with Session(eng) as s:
        reconcile(session=s, store=FileStore(str(root)))
    assert _counter(eng) == _all_bytes(root)
    eng.dispose()


@needs_permissions
def test_retained_and_published_bytes_never_return_a_partial_total(tmp_path):
    from app.storage.file_store import StorageScanError

    root = tmp_path / "store"
    store = FileStore(str(root))
    store.write_once(3, hashlib.sha256(png((92, 1, 1))).hexdigest(), png((92, 1, 1)))
    (root / "3").chmod(0o000)
    try:
        with pytest.raises(StorageScanError):
            store.retained_bytes()
        with pytest.raises(StorageScanError):
            store.published_bytes()
    finally:
        (root / "3").chmod(0o700)
    assert store.retained_bytes() == store.published_bytes() == len(png((92, 1, 1)))


# ===================================================================== blockers: publication root

@needs_permissions
def test_preflight_rejects_a_vault_root_that_is_not_writable_even_if_tmp_is(tmp_path):
    from app.preflight import storage_errors

    root = tmp_path / "volume" / "storage"
    store = FileStore(str(root))
    data = png((93, 1, 1))
    rel = store.write_once(4, hashlib.sha256(data).hexdigest(), data)   # an existing original
    original = root / rel
    before = (hashlib.sha256(original.read_bytes()).hexdigest(), os.stat(original).st_mtime_ns)
    (root / ".tmp").chmod(0o700)                         # .tmp/ itself stays writable
    root_mode = root.stat().st_mode & 0o777
    root.chmod(0o500)                                    # but nothing can be published
    try:
        assert os.access(root / ".tmp", os.W_OK) and not os.access(root, os.W_OK)
        errors = storage_errors(str(root), ismount=_mounted(tmp_path))
        assert errors and "directly under" in errors[0], errors
        full = preflight_errors(_env(tmp_path), ismount=_mounted(tmp_path))
        assert any("STORAGE_ROOT is not writable" in e for e in full), full
        assert sorted(p.name for p in root.iterdir()) == [".tmp", "4"]  # no probe left behind
    finally:
        root.chmod(root_mode)
    assert (hashlib.sha256(original.read_bytes()).hexdigest(), os.stat(original).st_mtime_ns) == before
    # Writable again: passes, and leaves nothing behind.
    assert storage_errors(str(root), ismount=_mounted(tmp_path)) == []
    assert sorted(p.name for p in root.iterdir()) == [".tmp", "4"]
    assert [p.name for p in (root / ".tmp").iterdir()] == []


def test_start_script_runs_preflight_before_any_migration():
    lines = [ln.strip() for ln in (REPO / "deploy" / "start.sh").read_text().splitlines()
             if ln.strip().startswith(("python", "exec python"))]
    assert lines[0] == "python -m app.preflight" and "alembic" in lines[1]


# ===================================================================== P2 origin normalization

@pytest.mark.parametrize("origin", [
    "https://evil.example\\.graveyard.example.com", "https://graveyard.example.com\\", "https:\\\\graveyard.example.com",
    "https://graveyard.example.com\\@evil.example",
])
def test_p2_backslashes_are_rejected(origin):
    errors = production_config_errors(GOOD | {"TRUSTED_ORIGINS": origin})
    assert any("TRUSTED_ORIGINS" in e for e in errors), (origin, errors)


@pytest.mark.parametrize("raw, expected", [
    ("https://Graveyard.example.com:443", "https://graveyard.example.com"),
    ("https://graveyard.example.com:443/", "https://graveyard.example.com"),
    ("http://localhost:80", "http://localhost"),
    ("https://graveyard.example.com:8443", "https://graveyard.example.com:8443"),
    ("https://[::1]:443", "https://[::1]"),
])
def test_p2_explicit_default_ports_normalize_to_what_browsers_send(raw, expected):
    from app.production_checks import normalize_origin

    assert normalize_origin(raw) == expected
    env = {k: v for k, v in os.environ.items() if k not in {"APP_ENV", "TRUSTED_ORIGINS"}}
    env["TRUSTED_ORIGINS"] = raw
    r = subprocess.run([PY, "-c", "import app.config as c; print(c.TRUSTED_ORIGINS)"], cwd=BACKEND, env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and r.stdout.strip() == repr((expected,)), r.stderr[-300:]


def test_p2_https_default_port_passes_production_checks_and_backslash_fails_config():
    assert production_config_errors(GOOD | {"TRUSTED_ORIGINS": "https://graveyard.example.com:443"}) == []
    env = {k: v for k, v in os.environ.items() if k not in {"APP_ENV", "TRUSTED_ORIGINS"}}
    env["TRUSTED_ORIGINS"] = "https://evil.example\\.a.example.com"
    r = subprocess.run([PY, "-c", "import app.config"], cwd=BACKEND, env=env, capture_output=True, text=True,
                       timeout=60)
    assert r.returncode != 0 and "TRUSTED_ORIGINS" in r.stderr
