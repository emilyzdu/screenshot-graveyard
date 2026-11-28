"""Deployment Foundation P1 remediation: adversarial regression tests.

P1-1 placeholder operations; P1-2 physical storage cap; P1-3 database URL
safety; P1-4 build-context allowlist (static emulation only); P1-5 preflight
ordering; P2 strict list settings. Mocked provider only; no live AI.
"""

from __future__ import annotations

import fnmatch
import hashlib
import os
import re
import stat
import subprocess
import sys
import threading
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app import config
from app.db import models
from app.db.base import Base
from app.db.url import DatabaseURLError, parse_database_url, redact
from app.preflight import preflight_errors, storage_errors
from app.production_checks import production_config_errors
from app.services import vault_service
from app.services.global_usage_service import GlobalUsageService
from app.services.vault_service import StorageLimitError, VaultService, VaultServiceError
from app.storage.file_store import FileStore
from app.storage_reconcile import reconcile
from tests.test_deploy_foundation import GOOD
from tests.test_real_provider_integration import HDRS, env, png, upload  # noqa: F401  (env is a fixture)

BACKEND = Path(__file__).resolve().parent.parent
REPO = BACKEND.parent
PY = sys.executable
SYNTH_PASSWORD = "Synth@Pass:w/rd%x"  # synthetic only; never a real credential


def _ai_calls(eng):
    with Session(eng) as s:
        return GlobalUsageService(s).ai_calls_today()


# ===================================================================== P1-1 placeholder operations

def test_p1_1_placeholders_cannot_exhaust_another_workspaces_ai_quota(env, monkeypatch):
    make_client, eng, client = env
    monkeypatch.setattr(config, "MAX_AI_CALLS_PER_DAY", 1)
    attacker, victim = make_client(), make_client()
    for kind in ("classify", "study_note", "redo") * 3:  # source-less, no consent, no worker
        r = attacker.post("/api/operations", headers=HDRS, json={"kind": kind})
        assert r.status_code == 202
    assert _ai_calls(eng) == 0  # never charged to the deployment-wide quota
    sid, _ = upload(victim, (201, 1, 1))
    assert victim.post(f"/api/screenshots/{sid}/classify", headers=HDRS).status_code == 202
    assert _ai_calls(eng) == 1 and len(client.calls) == 1


def test_p1_1_placeholder_quota_refusal_is_a_429_not_a_500(env, monkeypatch):
    make_client, eng, client = env
    monkeypatch.setattr(config, "MAX_AI_CALLS_PER_WORKSPACE", 1)
    c = make_client()
    assert c.post("/api/operations", headers=HDRS, json={"kind": "classify"}).status_code == 202
    r = c.post("/api/operations", headers=HDRS, json={"kind": "classify"})
    assert r.status_code == 429 and r.json()["error"]["code"] == "quota_exceeded"


def test_p1_1_the_scaffold_is_not_exposed_in_production_and_polling_still_works(env, monkeypatch):
    make_client, eng, client = env
    c = make_client()
    sid, _ = upload(c, (202, 1, 1))
    op_id = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()["operationId"]
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    r = c.post("/api/operations", headers=HDRS, json={"kind": "classify"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    assert c.get(f"/api/operations/{op_id}").json()["status"] == "successful"
    assert _ai_calls(eng) == 1


# ===================================================================== P1-2 physical storage cap

def _file_db(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 's.sqlite'}", connect_args={"check_same_thread": False, "timeout": 20},
                        poolclass=NullPool)
    Base.metadata.create_all(eng)
    return eng


def _workspaces(eng, n):
    with Session(eng) as s:
        rows = [models.Workspace(token_hash=f"{i + 7:064d}") for i in range(n)]
        s.add_all(rows)
        s.commit()
        return [r.id for r in rows]


def _image(i: int) -> bytes:
    return png((i % 250, (i * 7) % 250, 3))


@pytest.fixture()
def store_root(tmp_path, monkeypatch):
    root = tmp_path / "store"
    monkeypatch.setattr(config, "STORAGE_ROOT", str(root))
    return root


def _physical(root) -> int:
    return FileStore(str(root)).published_bytes()


def test_p1_2_parallel_uploads_from_many_workspaces_never_exceed_the_cap(tmp_path, store_root, monkeypatch):
    eng = _file_db(tmp_path)
    ws = _workspaces(eng, 4)
    images = [_image(i) for i in range(12)]
    sizes = [len(b) for b in images]
    cap = sum(sorted(sizes)[:3])  # room for about three images
    monkeypatch.setattr(config, "MAX_TOTAL_STORAGE_BYTES", cap)
    # Every thread passes the early check at once (the reproduced race).
    monkeypatch.setattr(VaultService, "_precheck_limits", lambda self, v: None)
    outcomes = []
    lock = threading.Lock()

    def attempt(i):
        with Session(eng) as s:
            try:
                VaultService(s, ws[i % 4]).upload(images[i], filename=f"{i}.png")
                r = "ok"
            except StorageLimitError:
                r = "full"
        with lock:
            outcomes.append(r)

    threads = [threading.Thread(target=attempt, args=(i,)) for i in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert outcomes.count("ok") >= 1 and outcomes.count("full") >= 1
    physical = _physical(store_root)
    assert physical <= cap  # the PHYSICAL bytes on disk respect the cap
    with Session(eng) as s:
        assert GlobalUsageService(s).storage_used() == physical
        assert len(list(s.scalars(select(models.Screenshot)))) == outcomes.count("ok")
    eng.dispose()


def test_p1_2_duplicates_reuse_bytes_and_other_workspaces_need_their_own(tmp_path, store_root, monkeypatch):
    eng = _file_db(tmp_path)
    a, b = _workspaces(eng, 2)
    data = _image(1)
    monkeypatch.setattr(config, "MAX_TOTAL_STORAGE_BYTES", len(data))
    with Session(eng) as s:
        VaultService(s, a).upload(data, filename="1.png")
    with Session(eng) as s:  # same content, same workspace, at the cap: no new bytes
        assert VaultService(s, a).upload(data, filename="again.png").is_duplicate is True
    with Session(eng) as s:  # same content in ANOTHER workspace is stored separately
        with pytest.raises(StorageLimitError):
            VaultService(s, b).upload(data, filename="1.png")
    assert _physical(store_root) == len(data)
    eng.dispose()


def test_p1_2_bytes_kept_after_a_failed_metadata_transaction_stay_counted(tmp_path, store_root, monkeypatch):
    eng = _file_db(tmp_path)
    (w,) = _workspaces(eng, 1)
    data = _image(2)
    from app.db.repository import WorkspaceRepository

    def boom(self, **kw):
        raise RuntimeError("database failure after publication")

    monkeypatch.setattr(WorkspaceRepository, "create_screenshot", boom)
    with Session(eng) as s:
        with pytest.raises(VaultServiceError):
            VaultService(s, w).upload(data, filename="x.png")
    # The published original is retained (write-once, never deleted) AND counted.
    assert _physical(store_root) == len(data)
    with Session(eng) as s:
        assert GlobalUsageService(s).storage_used() == len(data)
        assert list(s.scalars(select(models.Screenshot))) == []
    eng.dispose()


def test_p1_2_reconciliation_after_restart_matches_the_disk_and_touches_no_file(tmp_path, store_root):
    eng = _file_db(tmp_path)
    (w,) = _workspaces(eng, 1)
    with Session(eng) as s:
        VaultService(s, w).upload(_image(3), filename="a.png")
    # A crash between reservation and write leaves an over-count...
    with Session(eng) as s:
        GlobalUsageService(s).reserve_storage(5000, 10**9, free_bytes=10**12, min_free=0)
        s.commit()
    # ...and a file no reservation covered (stored before the counter existed).
    legacy = store_root / str(w) / "ff" / "ee" / ("f" * 64)
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_bytes(b"x" * 123)
    snapshot = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in store_root.rglob("*") if p.is_file()}
    eng.dispose()
    eng2 = create_engine(f"sqlite:///{tmp_path / 's.sqlite'}", poolclass=NullPool)  # simulated restart
    with Session(eng2) as s:
        before, after = reconcile(session=s, store=FileStore(str(store_root)))
    assert before == len(_image(3)) + 5000 and after == len(_image(3)) + 123
    assert {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in store_root.rglob("*") if p.is_file()} == snapshot
    eng2.dispose()


def test_p1_2_free_space_floor_is_enforced_at_the_authoritative_stage(tmp_path, store_root, monkeypatch):
    """Simulated volume: free space = budget minus what is physically written."""
    eng = _file_db(tmp_path)
    ws = _workspaces(eng, 3)
    images = [_image(i + 20) for i in range(9)]
    floor = 100
    budget = floor + sum(sorted(len(b) for b in images)[:2])
    monkeypatch.setattr(config, "STORAGE_MIN_FREE_BYTES", floor)
    monkeypatch.setattr(vault_service, "_free_bytes", lambda path: budget - _physical(store_root))
    monkeypatch.setattr(VaultService, "_precheck_limits", lambda self, v: None)
    results = []
    lock = threading.Lock()

    def attempt(i):
        with Session(eng) as s:
            try:
                VaultService(s, ws[i % 3]).upload(images[i], filename=f"{i}.png")
                r = "ok"
            except StorageLimitError:
                r = "full"
        with lock:
            results.append(r)

    threads = [threading.Thread(target=attempt, args=(i,)) for i in range(9)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert budget - _physical(store_root) >= floor  # the floor held under concurrency
    assert results.count("full") >= 1
    eng.dispose()


def test_p1_2_a_refused_reservation_writes_nothing(env, monkeypatch):
    make_client, eng, client = env
    monkeypatch.setattr(config, "MAX_TOTAL_STORAGE_BYTES", 10)
    monkeypatch.setattr(VaultService, "_precheck_limits", lambda self, v: None)
    c = make_client()
    content = lambda: sorted(p for p in Path(config.STORAGE_ROOT).rglob("*") if p.is_file() and ".tmp" not in p.parts)
    before = content()
    r = c.post("/api/screenshots", headers=HDRS, files=[("files", ("x.png", png((203, 1, 1)), "image/png"))])
    assert r.json()["results"][0]["status"] == "rejected"
    assert content() == before  # (nothing is published outside .tmp/)


# ===================================================================== P1-3 database URL safety

def test_p1_3_encoded_passwords_and_reserved_characters_parse_exactly():
    url = parse_database_url("postgresql+psycopg://us%40er:Synth%40Pass%3Aw%2Frd%25x@db.internal:5432/sg?sslmode=require")
    assert url.username == "us@er" and url.password == SYNTH_PASSWORD
    assert url.host == "db.internal" and url.database == "sg" and url.query["sslmode"] == "require"
    assert SYNTH_PASSWORD not in url.render_as_string(hide_password=True)


def test_p1_3_a_malformed_url_never_echoes_its_value():
    raw = f"postgresql+psycopg://u:{SYNTH_PASSWORD}@@::bad"
    with pytest.raises(DatabaseURLError) as err:
        parse_database_url("not a url " + raw)
    assert SYNTH_PASSWORD not in str(err.value) and "Synth" not in str(err.value)
    assert redact(f"boom {SYNTH_PASSWORD} and Synth%40Pass%3Aw%2Frd%25x",
                  "postgresql+psycopg://u:Synth%40Pass%3Aw%2Frd%25x@h/db").count("Synth") == 0


def _alembic(url: str, tmp_path: Path, *args: str):
    env = {k: v for k, v in os.environ.items() if k not in {"DATABASE_URL", "APP_ENV", "STORAGE_ROOT"}}
    env["DATABASE_URL"] = url
    return subprocess.run([PY, "-m", "alembic", *args], cwd=BACKEND, env=env, capture_output=True, text=True,
                          timeout=180)


def test_p1_3_alembic_accepts_percent_encoded_urls(tmp_path):
    # The URL carries "%40" (as an encoded password would); SQLAlchemy decodes it
    # to "@", so the folder on disk is literally "db@dir". Before the fix,
    # Alembic's ConfigParser crashed on the "%" with "invalid interpolation".
    folder = tmp_path / "db@dir"
    folder.mkdir()
    url = f"sqlite:///{tmp_path.as_posix()}/db%40dir/m.db"
    r = _alembic(url, tmp_path, "upgrade", "head")
    assert r.returncode == 0, r.stderr[-800:]
    assert "invalid interpolation" not in r.stderr
    eng = create_engine(url)
    with eng.connect() as c:
        assert c.exec_driver_sql("select version_num from alembic_version").scalar() == "f8d3c0a50001"
    eng.dispose()


def test_p1_3_migration_failures_do_not_log_the_password(tmp_path):
    malformed = _alembic(f"postgresql+psycopg://u:{SYNTH_PASSWORD}@@::bad/db", tmp_path, "upgrade", "head")
    assert malformed.returncode != 0
    assert "Synth" not in malformed.stderr + malformed.stdout
    encoded = "postgresql+psycopg://user:Synth%40Pass%3Aw%2Frd%25x@127.0.0.1:1/sg"
    failed = _alembic(encoded, tmp_path, "upgrade", "head")
    assert failed.returncode != 0
    out = failed.stderr + failed.stdout
    assert "Synth" not in out and "invalid interpolation" not in out


def test_p1_3_sqlite_development_engine_is_unchanged(tmp_path):
    from app.db.session import make_engine

    eng = make_engine(f"sqlite:///{tmp_path / 'd.db'}")
    with eng.connect() as c:
        assert c.exec_driver_sql("select 1").scalar() == 1
    eng.dispose()
    with pytest.raises(DatabaseURLError):
        make_engine("::::")


# ===================================================================== P1-4 build context (static emulation)

def _dockerignore_rules():
    rules = []
    for line in (REPO / ".dockerignore").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        neg = line.startswith("!")
        pat = line[1:] if neg else line
        rules.append((neg, pat.strip("/")))
    return rules


def _pattern_regex(pat: str) -> re.Pattern:
    out = ""
    i = 0
    while i < len(pat):
        if pat.startswith("**/", i):
            out += "(?:.*/)?"
            i += 3
        elif pat.startswith("**", i):
            out += ".*"
            i += 2
        elif pat[i] == "*":
            out += "[^/]*"
            i += 1
        elif pat[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(pat[i])
            i += 1
    return re.compile(out + r"\Z")


def _excluded(path: str, rules) -> bool:
    """Docker semantics, emulated: the last matching rule wins; a rule matches a
    path or any of its parent directories."""
    parts = path.split("/")
    candidates = ["/".join(parts[: i + 1]) for i in range(len(parts))]
    excluded = False
    for neg, pat in rules:
        rx = _pattern_regex(pat)
        if any(rx.match(c) for c in candidates):
            excluded = not neg
    return excluded


SENTINELS = [
    ".env", "frontend/.env.local", "backend/.env", "backend/app/.env", "backend/app/.env.production",
    "backend/app/server.key", "backend/app/cert.pem", "frontend/src/service-secret.json",
    "backend/app/db_credentials.txt", "backend/local.db", "backend/local.db-wal", "backend/local.db-shm",
    "backend/app/cache.sqlite3", "backend/var/storage/1/ab/cd/" + "a" * 64,
    "frontend/node_modules/x/index.js", "frontend/dist/index.html", "backend/app/__pycache__/x.pyc",
    "frontend/tsconfig.app.tsbuildinfo", "backend/tests/test_x.py", ".git/config", "docs/notes.md",
]
REQUIRED = [
    "backend/app/main.py", "backend/app/storage/file_store.py", "backend/app/preflight.py",
    "backend/alembic/env.py", "backend/alembic.ini", "backend/requirements.txt", "deploy/start.sh",
    "frontend/package.json", "frontend/package-lock.json", "frontend/index.html", "frontend/src/main.tsx",
    "frontend/vite.config.ts", "frontend/tsconfig.app.json", "frontend/public/vite.svg",
]


@pytest.mark.parametrize("path", SENTINELS)
def test_p1_4_sensitive_paths_are_excluded_from_the_build_context(path):
    assert _excluded(path, _dockerignore_rules()), path


@pytest.mark.parametrize("path", REQUIRED)
def test_p1_4_required_build_inputs_are_included(path):
    assert not _excluded(path, _dockerignore_rules()), path


def test_p1_4_every_real_file_in_the_allowed_directories_is_safe():
    rules = _dockerignore_rules()
    bad = re.compile(r"(\.env|\.pem|\.key|\.db|\.sqlite|secret|credential)", re.I)
    shipped = []
    for root in ("backend/app", "backend/alembic", "frontend/src", "frontend/public"):
        for p in (REPO / root).rglob("*"):
            rel = p.relative_to(REPO).as_posix()
            if p.is_file() and not _excluded(rel, rules):
                shipped.append(rel)
                assert not bad.search(p.name), rel
    assert "backend/app/storage/file_store.py" in shipped


def test_p1_4_dockerfile_copies_only_allowlisted_inputs():
    allowed = {
        "frontend/package.json", "frontend/package-lock.json", "frontend/index.html", "frontend/vite.config.ts",
        "frontend/tsconfig.json", "frontend/tsconfig.app.json", "frontend/tsconfig.node.json", "frontend/src",
        "frontend/public", "backend/requirements.txt", "backend/alembic.ini", "backend/alembic", "backend/app",
        "deploy/start.sh", "deploy/verify-world-assets.mjs",
    }
    sources = []
    for line in (REPO / "Dockerfile").read_text().splitlines():
        parts = line.split()
        if parts[:1] == ["COPY"] and not any(p.startswith("--from") for p in parts):
            sources.extend(parts[1:-1])
    assert sources and set(sources) <= allowed, set(sources) - allowed
    assert "." not in sources


# ===================================================================== P1-5 preflight

def _env(tmp_path, **over):
    root = tmp_path / "volume" / "storage"
    e = GOOD | {"STORAGE_ROOT": str(root)}
    e.update(over)
    return {k: v for k, v in e.items() if v is not None}


def _mounted(tmp_path):
    vol = os.path.realpath(tmp_path / "volume")
    os.makedirs(vol, exist_ok=True)
    return lambda p: os.path.realpath(p) in {"/", vol}


def test_p1_5_a_mounted_writable_volume_passes(tmp_path):
    assert preflight_errors(_env(tmp_path), ismount=_mounted(tmp_path)) == []
    leftovers = list((tmp_path / "volume" / "storage" / ".tmp").iterdir())
    assert leftovers == []  # the probe file is removed


@pytest.mark.parametrize("over, fragment", [
    ({"APP_ENV": "development"}, "APP_ENV must be 'production'"),
    ({"DATABASE_URL": None}, "DATABASE_URL must be set"),
    ({"TRUSTED_ORIGINS": ","}, "TRUSTED_ORIGINS must list at least one"),
    ({"TRUSTED_PROXY_CIDRS": ","}, "TRUSTED_PROXY_CIDRS lists no network"),
    ({"STORAGE_ROOT": "relative/path"}, "absolute"),
    ({"STORAGE_ROOT": "/tmp/sg-storage"}, "ephemeral"),
    ({"STORAGE_ROOT": "/var/tmp/sg-storage"}, "ephemeral"),
])
def test_p1_5_malformed_or_missing_settings_refuse_to_start(tmp_path, over, fragment):
    errors = preflight_errors(_env(tmp_path, **over), ismount=_mounted(tmp_path))
    assert any(fragment in e for e in errors), errors


def test_p1_5_an_unmounted_path_is_not_accepted_as_persistent(tmp_path):
    errors = storage_errors(str(tmp_path / "volume" / "storage"), ismount=lambda p: os.path.realpath(p) == "/")
    assert errors and "not on a mounted persistent volume" in errors[0]


def test_p1_5_an_unwritable_volume_is_refused(tmp_path):
    if os.geteuid() == 0:
        pytest.skip("root can write anywhere")
    vol = tmp_path / "volume"
    root = vol / "storage"
    root.mkdir(parents=True)
    os.chmod(root, stat.S_IRUSR | stat.S_IXUSR)
    try:
        errors = storage_errors(str(root), ismount=_mounted(tmp_path))
        assert errors and "not writable by the runtime user" in errors[0]
    finally:
        os.chmod(root, stat.S_IRWXU)


def _fake_python(tmp_path, fail_on: str | None):
    bindir = tmp_path / "bin"
    bindir.mkdir()
    log = tmp_path / "calls.log"
    script = bindir / "python"
    script.write_text(
        "#!/bin/sh\n"
        f'echo "$*" >> "{log}"\n'
        + (f'case "$*" in *{fail_on}*) exit 1;; esac\n' if fail_on else "")
        + "exit 0\n"
    )
    script.chmod(0o755)
    (tmp_path / "app" / "backend").mkdir(parents=True)
    return bindir, log


@pytest.mark.parametrize("fail_on, expected", [
    ("app.preflight", ["-m app.preflight"]),                         # nothing after a failed preflight
    ("alembic", ["-m app.preflight", "-m alembic upgrade head"]),     # nothing served after a failed migration
    (None, ["-m app.preflight", "-m alembic upgrade head", "-m app.storage_reconcile",
            "-m uvicorn app.main:app --host 0.0.0.0 --port 9999 --workers 1 --no-proxy-headers"]),
])
def test_p1_5_start_script_runs_preflight_before_any_migration(tmp_path, fail_on, expected):
    bindir, log = _fake_python(tmp_path, fail_on)
    env = {"PATH": f"{bindir}:/usr/bin:/bin", "APP_HOME": str(tmp_path / "app"), "PORT": "9999"}
    r = subprocess.run(["/bin/sh", str(REPO / "deploy" / "start.sh")], env=env, capture_output=True, text=True,
                       timeout=60)
    assert (r.returncode == 0) is (fail_on is None)
    assert log.read_text().splitlines() == expected


def test_p1_5_the_release_image_defaults_to_production():
    dockerfile = (REPO / "Dockerfile").read_text()
    assert re.search(r"^ENV APP_ENV=production\b", dockerfile, re.M)
    assert 'CMD ["/app/deploy/start.sh"]' in dockerfile


# ===================================================================== P2 strict list settings

@pytest.mark.parametrize("raw", [",", " , ,", "none,10.0.0.0/8", "0.0.0.0/0", "::/0", "10.0.0.0/8,banana"])
def test_p2_proxy_settings_that_list_nothing_or_everything_are_rejected(raw):
    with pytest.raises(RuntimeError):
        config._parse_proxy_networks(raw)
    errors = production_config_errors(GOOD | {"TRUSTED_PROXY_CIDRS": raw})
    assert any("TRUSTED_PROXY_CIDRS" in e for e in errors), (raw, errors)


@pytest.mark.parametrize("raw", ["none", " NONE ", "none,"])
def test_p2_none_explicitly_disables_forwarding(raw):
    assert config._parse_proxy_networks(raw) == ()
    assert production_config_errors(GOOD | {"TRUSTED_PROXY_CIDRS": raw}) == []


def test_p2_comma_only_trusted_origins_fail_fast():
    env = {k: v for k, v in os.environ.items() if k not in {"APP_ENV", "TRUSTED_ORIGINS"}}
    env["TRUSTED_ORIGINS"] = " , "
    r = subprocess.run([PY, "-c", "import app.config"], cwd=BACKEND, env=env, capture_output=True, text=True,
                       timeout=60)
    assert r.returncode != 0 and "TRUSTED_ORIGINS must list at least one origin" in r.stderr
    assert any("TRUSTED_ORIGINS" in e for e in production_config_errors(GOOD | {"TRUSTED_ORIGINS": ","}))


def test_p2_uvicorn_proxy_header_rewriting_stays_disabled():
    script = (REPO / "deploy" / "start.sh").read_text()
    assert "--no-proxy-headers" in script and "--workers 1" in script
    assert "--proxy-headers " not in script and "forwarded-allow-ips" not in script
