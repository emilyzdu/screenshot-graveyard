"""Deployment foundation: global limits, proxy IP handling, production checks.

Mocked provider only (the scripted OpenAI client; real sockets blocked).
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import tomllib
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from starlette.requests import Request

from app import config
from app.db import models
from app.db.base import Base
from app.middleware.limits import client_ip
from app.ai.openai_vision_adapter import _WireClassification
from app.production_checks import production_config_errors
from app.services import vault_service
from app.services.global_usage_service import (
    GlobalAIBudgetExceededError,
    GlobalStorageLimitError,
    GlobalUsageService,
)
from app.services.operation_service import (
    OperationGlobalBudgetExceededError,
    OperationQuotaExceededError,
    OperationService,
)
from tests.consent_helpers import grant_body
from tests.test_real_provider_integration import HDRS, env, png, upload  # noqa: F401  (env is a fixture)

BACKEND = Path(__file__).resolve().parent.parent
PY = sys.executable


def _ai_calls(eng):
    with Session(eng) as s:
        return GlobalUsageService(s).ai_calls_today()


def _storage_counter(eng):
    with Session(eng) as s:
        return GlobalUsageService(s).storage_used()


def _files(root) -> list[Path]:
    return sorted(p for p in Path(root).rglob("*") if p.is_file() and ".tmp" not in p.parts)


# ===================================================================== global AI budget

def test_global_ai_budget_is_exhausted_across_workspaces_and_sends_nothing(env, monkeypatch):
    make_client, eng, client = env
    monkeypatch.setattr(config, "MAX_AI_CALLS_PER_DAY", 2)
    a, b = make_client(), make_client()  # b is a brand-new workspace (bypass attempt)
    s1, _ = upload(a, (1, 1, 1))
    s2, _ = upload(a, (2, 1, 1))
    s3, _ = upload(b, (3, 1, 1))
    assert a.post(f"/api/screenshots/{s1}/classify", headers=HDRS).status_code == 202
    assert a.post(f"/api/screenshots/{s2}/classify", headers=HDRS).status_code == 202
    r = b.post(f"/api/screenshots/{s3}/classify", headers=HDRS)
    assert r.status_code == 429 and r.json()["error"]["code"] == "ai_budget_reached"
    assert "Nothing was sent" in r.json()["error"]["message"]
    assert len(client.calls) == 2 and _ai_calls(eng) == 2
    # Every AI entry point reports the same refusal.
    for path, body in [(f"/api/screenshots/{s3}/preparations", {"action": "add_calendar"})]:
        r = b.post(path, headers=HDRS, json=body)
        assert r.status_code == 429 and r.json()["error"]["code"] == "ai_budget_reached"
    assert b.post("/api/workspace/automation", headers=HDRS, json={"autoPrepare": True}).status_code == 200
    r = b.post(f"/api/screenshots/{s3}/auto-process", headers=HDRS)
    assert r.status_code == 429 and r.json()["error"]["code"] == "ai_budget_reached"
    assert len(client.calls) == 2


def test_a_reused_operation_costs_no_budget_and_consent_still_comes_first(env, monkeypatch):
    make_client, eng, client = env
    monkeypatch.setattr(config, "MAX_AI_CALLS_PER_DAY", 1)
    c = make_client()
    sid, _ = upload(c, (4, 1, 1))
    first = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS).json()
    again = c.post(f"/api/screenshots/{sid}/classify", headers=HDRS)
    assert again.status_code == 202 and again.json()["operationId"] == first["operationId"]  # reused
    assert _ai_calls(eng) == 1
    other, _ = upload(c, (5, 1, 1), consent=False)
    r = c.post(f"/api/screenshots/{other}/classify", headers=HDRS)
    assert r.status_code == 403  # consent is checked before any budget is touched
    assert _ai_calls(eng) == 1


def test_the_per_workspace_quota_still_applies_and_keeps_its_code(env, monkeypatch):
    make_client, eng, client = env
    monkeypatch.setattr(config, "MAX_AI_CALLS_PER_WORKSPACE", 1)
    c = make_client()
    s1, _ = upload(c, (6, 1, 1))
    s2, _ = upload(c, (7, 1, 1))
    c.post(f"/api/screenshots/{s1}/classify", headers=HDRS)
    r = c.post(f"/api/screenshots/{s2}/classify", headers=HDRS)
    assert r.status_code == 429 and r.json()["error"]["code"] == "quota_exceeded"
    assert _ai_calls(eng) == 1  # a workspace refusal reserves nothing globally
    fresh = make_client()
    s3, _ = upload(fresh, (8, 1, 1))
    assert fresh.post(f"/api/screenshots/{s3}/classify", headers=HDRS).status_code == 202


def test_explicit_redo_counts_as_a_new_request(env, monkeypatch):
    make_client, eng, client = env
    monkeypatch.setattr(config, "MAX_AI_CALLS_PER_DAY", 1)
    c = make_client()
    sid, _ = upload(c, (9, 1, 1))
    c.post(f"/api/screenshots/{sid}/classify", headers=HDRS)
    r = c.post(f"/api/screenshots/{sid}/analysis/redo", headers=HDRS, json={})
    assert r.status_code == 429 and r.json()["error"]["code"] == "ai_budget_reached"
    assert len(client.calls) == 1


def _file_db(tmp_path, name="g.sqlite"):
    eng = create_engine(f"sqlite:///{tmp_path / name}", connect_args={"check_same_thread": False, "timeout": 15},
                        poolclass=NullPool)
    Base.metadata.create_all(eng)
    return eng


def _workspaces(eng, n):
    with Session(eng) as s:
        rows = [models.Workspace(token_hash=f"{i:064d}") for i in range(n)]
        s.add_all(rows)
        s.commit()
        return [r.id for r in rows]


def test_concurrent_reservations_from_many_workspaces_never_exceed_the_budget(tmp_path, monkeypatch):
    eng = _file_db(tmp_path)
    monkeypatch.setattr(config, "MAX_AI_CALLS_PER_DAY", 5)
    ws = _workspaces(eng, 4)
    outcomes: list[str] = []
    lock = threading.Lock()

    def attempt(workspace_id):
        with Session(eng) as s:
            try:
                OperationService(s, workspace_id).create_pending("classify")
                result = "ok"
            except OperationGlobalBudgetExceededError:
                result = "budget"
        with lock:
            outcomes.append(result)

    threads = [threading.Thread(target=attempt, args=(ws[i % 4],)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert outcomes.count("ok") == 5 and outcomes.count("budget") == 15
    with Session(eng) as s:
        assert s.scalar(select(models.Operation.id).order_by(models.Operation.id.desc())) is not None
        assert len(list(s.scalars(select(models.Operation)))) == 5
    assert _ai_calls(eng) == 5
    eng.dispose()


def test_the_budget_survives_a_restart_and_resets_by_utc_day(tmp_path, monkeypatch):
    eng = _file_db(tmp_path)
    monkeypatch.setattr(config, "MAX_AI_CALLS_PER_DAY", 2)
    (w,) = _workspaces(eng, 1)
    for _ in range(2):
        with Session(eng) as s:
            OperationService(s, w).create_pending("classify")
    eng.dispose()  # simulated restart: a fresh engine over the same database file
    eng2 = create_engine(f"sqlite:///{tmp_path / 'g.sqlite'}", poolclass=NullPool)
    with Session(eng2) as s:
        with pytest.raises(OperationQuotaExceededError) as err:
            OperationService(s, w).create_pending("classify")
        assert err.value.code == "ai_budget_reached"
    with Session(eng2) as s:  # a new UTC day has its own budget
        s.connection()
        tomorrow = datetime(2099, 1, 2, tzinfo=timezone.utc)
        GlobalUsageService(s).reserve_ai_call(2, now=tomorrow)
        s.commit()
        assert GlobalUsageService(s).ai_calls_today(now=tomorrow) == 1
    eng2.dispose()


def test_reservation_rolls_back_with_its_transaction(tmp_path):
    eng = _file_db(tmp_path)
    with Session(eng) as s:
        GlobalUsageService(s).reserve_ai_call(10)
        s.rollback()
    with Session(eng) as s:
        assert GlobalUsageService(s).ai_calls_today() == 0
        with pytest.raises(GlobalAIBudgetExceededError):
            GlobalUsageService(s).reserve_ai_call(0)
    eng.dispose()


# ===================================================================== storage

def test_global_storage_limit_refuses_new_bytes_across_workspaces_without_writing(env, monkeypatch):
    make_client, eng, client = env
    one = len(png((10, 1, 1)))
    monkeypatch.setattr(config, "MAX_TOTAL_STORAGE_BYTES", one + 5)
    a, b = make_client(), make_client()
    sid, data = upload(a, (10, 1, 1), consent=False)
    assert _storage_counter(eng) == one
    before = _files(config.STORAGE_ROOT)
    r = b.post("/api/screenshots", headers=HDRS, files=[("files", ("x.png", png((11, 1, 1)), "image/png"))])
    res = r.json()["results"][0]
    assert res["status"] == "rejected" and "Storage is full" in res["error"]
    assert _files(config.STORAGE_ROOT) == before  # nothing written for the refused upload
    assert _storage_counter(eng) == one
    # The same content again in the same workspace adds no bytes and is accepted.
    r = a.post("/api/screenshots", headers=HDRS, files=[("files", ("again.png", data, "image/png"))])
    assert r.json()["results"][0]["status"] == "accepted" and r.json()["results"][0]["isDuplicate"] is True
    # Existing files are never removed.
    assert all(p.exists() for p in before)
    assert a.get(f"/api/screenshots/{sid}/image").status_code == 200


def test_authoritative_storage_check_under_the_lock(tmp_path, monkeypatch):
    """Two uploads both pass the early check; only one may be counted."""
    eng = _file_db(tmp_path)
    (w,) = _workspaces(eng, 1)
    one = len(png((12, 1, 1)))
    monkeypatch.setattr(config, "MAX_TOTAL_STORAGE_BYTES", one + 5)
    monkeypatch.setattr(config, "STORAGE_ROOT", str(tmp_path / "store"))
    monkeypatch.setattr(vault_service.VaultService, "_precheck_limits", lambda self, v: None)  # race past it
    from app.services.vault_service import StorageLimitError, VaultService

    with Session(eng) as s:
        VaultService(s, w).upload(png((12, 1, 1)), filename="a.png")
    with Session(eng) as s:
        with pytest.raises(StorageLimitError):
            VaultService(s, w).upload(png((13, 1, 1)), filename="b.png")
    with Session(eng) as s:
        assert GlobalUsageService(s).storage_used() == one
        assert len(list(s.scalars(select(models.Screenshot)))) == 1
    eng.dispose()


def test_a_nearly_full_volume_refuses_uploads_before_writing(env, monkeypatch):
    make_client, eng, client = env
    monkeypatch.setattr(vault_service, "_free_bytes", lambda path: 10)
    c = make_client()
    before = _files(config.STORAGE_ROOT)
    r = c.post("/api/screenshots", headers=HDRS, files=[("files", ("x.png", png((14, 1, 1)), "image/png"))])
    assert r.json()["results"][0]["status"] == "rejected"
    assert _files(config.STORAGE_ROOT) == before


def test_per_workspace_quota_is_refused_before_writing(env, monkeypatch):
    make_client, eng, client = env
    monkeypatch.setattr(config, "MAX_SCREENSHOTS_PER_WORKSPACE", 1)
    c = make_client()
    upload(c, (15, 1, 1), consent=False)
    before = _files(config.STORAGE_ROOT)
    r = c.post("/api/screenshots", headers=HDRS, files=[("files", ("x.png", png((16, 1, 1)), "image/png"))])
    res = r.json()["results"][0]
    assert res["status"] == "rejected" and res["error"] == "Workspace screenshot quota exceeded"
    assert _files(config.STORAGE_ROOT) == before  # no orphan file for a refused upload
    other = make_client()  # another workspace still has its own quota
    upload(other, (16, 1, 1), consent=False)


def test_migration_counts_existing_content_and_deletes_nothing(tmp_path, monkeypatch):
    from alembic import command
    from alembic.config import Config

    url = f"sqlite:///{(tmp_path / 'm.db').as_posix()}"
    monkeypatch.setenv("DATABASE_URL", url)
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "d6b1a7e00001")
    e = create_engine(url)
    with e.begin() as c:
        c.execute(text("insert into workspace (id, token_hash, created_at) values (1, :h, CURRENT_TIMESTAMP)"), {"h": "f" * 64})
        for i, size in ((1, 100), (2, 50)):
            c.execute(text("insert into content_blob (id, workspace_id, sha256, byte_size, mime_type, storage_path, created_at) "
                           "values (:i, 1, :s, :b, 'image/png', 'x', CURRENT_TIMESTAMP)"), {"i": i, "s": str(i) * 64, "b": size})
    command.upgrade(cfg, "head")
    with e.connect() as c:
        assert c.execute(text("select version_num from alembic_version")).scalar() == "e7c2a9b00001"
        assert c.execute(text("select value from global_counter where name = 'storage_bytes'")).scalar() == 150
    command.downgrade(cfg, "d6b1a7e00001")
    with e.connect() as c:
        assert c.execute(text("select count(*) from content_blob")).scalar() == 2
    e.dispose()


# ===================================================================== proxy IP handling

def _req(peer, *xff):
    headers = [(b"x-forwarded-for", v.encode()) for v in xff]
    return Request({"type": "http", "method": "GET", "path": "/api/health", "headers": headers,
                    "client": (peer, 1234), "query_string": b""})


def _nets(*cidrs):
    return config._parse_proxy_networks(",".join(cidrs))


@pytest.mark.parametrize("peer, xff, nets, expected", [
    ("203.0.113.9", ["6.6.6.6"], (), "203.0.113.9"),                       # no trusted proxy: header ignored
    ("10.0.0.2", ["198.51.100.7"], ("10.0.0.0/8",), "198.51.100.7"),       # trusted proxy: real client
    ("10.0.0.2", ["6.6.6.6, 198.51.100.7"], ("10.0.0.0/8",), "198.51.100.7"),  # forged left entry ignored
    ("10.0.0.2", ["198.51.100.7, 10.0.0.9"], ("10.0.0.0/8",), "198.51.100.7"),  # chained trusted proxies
    ("203.0.113.9", ["198.51.100.7"], ("10.0.0.0/8",), "203.0.113.9"),     # untrusted peer cannot spoof
    ("10.0.0.2", ["not-an-ip"], ("10.0.0.0/8",), "10.0.0.2"),              # malformed: never guessed
    ("10.0.0.2", ["10.0.0.7"], ("10.0.0.0/8",), "10.0.0.2"),               # only proxies listed
    ("10.0.0.2", [], ("10.0.0.0/8",), "10.0.0.2"),                         # no header
    ("10.0.0.2", ["6.6.6.6", "198.51.100.7"], ("10.0.0.0/8",), "198.51.100.7"),  # several header lines
    ("fd00::1", ["2001:db8::5"], ("fd00::/8",), "2001:db8::5"),            # IPv6
])
def test_client_ip(peer, xff, nets, expected):
    assert client_ip(_req(peer, *xff), networks=_nets(*nets)) == expected


def test_two_clients_behind_the_trusted_proxy_get_separate_buckets(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import create_app
    from app.ratelimit import TokenBucketRateLimiter

    monkeypatch.setattr(config, "TRUSTED_PROXY_NETWORKS", _nets("10.0.0.0/8"))
    app = create_app(rate_limiter=TokenBucketRateLimiter(capacity=1, refill_per_sec=0.0001))
    proxy = TestClient(app, client=("10.0.0.2", 5000))
    assert proxy.get("/api/health", headers={"X-Forwarded-For": "198.51.100.1"}).status_code == 200
    assert proxy.get("/api/health", headers={"X-Forwarded-For": "198.51.100.1"}).status_code == 429
    assert proxy.get("/api/health", headers={"X-Forwarded-For": "198.51.100.2"}).status_code == 200
    direct = TestClient(app, client=("203.0.113.5", 5000))  # not a proxy: its header is ignored
    assert direct.get("/api/health", headers={"X-Forwarded-For": "198.51.100.3"}).status_code == 200
    assert direct.get("/api/health", headers={"X-Forwarded-For": "198.51.100.4"}).status_code == 429


def test_invalid_proxy_networks_fail_fast():
    with pytest.raises(RuntimeError):
        config._parse_proxy_networks("10.0.0.0/8, nonsense")
    assert config._parse_proxy_networks("none") == ()
    assert config._parse_proxy_networks(None) == ()


# ===================================================================== production environment

GOOD = {
    "APP_ENV": "production",
    "DATABASE_URL": "postgresql+psycopg://u:SECRET-PASSWORD@db.internal:5432/sg",
    "STORAGE_ROOT": "/var/data/storage",
    "TRUSTED_ORIGINS": "https://graveyard.example.com",
    "TRUSTED_PROXY_CIDRS": "10.0.0.0/8",
    "MAX_AI_CALLS_PER_DAY": "200",
    "MAX_TOTAL_STORAGE_BYTES": str(2 * 1024**3),
    "AI_PROVIDER": "openai",
    "OPENAI_API_KEY": "sk-test-NOT-A-REAL-KEY",
}


def test_a_complete_production_environment_passes():
    assert production_config_errors(GOOD) == []
    assert production_config_errors(GOOD | {"TRUSTED_PROXY_CIDRS": "none", "AI_PROVIDER": "fake"}) == []


@pytest.mark.parametrize("change, fragment", [
    ({"DATABASE_URL": None}, "DATABASE_URL must be set"),
    ({"DATABASE_URL": "sqlite:////var/data/x.db"}, "psycopg driver"),
    ({"DATABASE_URL": "postgresql://u@h/db"}, "psycopg driver"),
    ({"STORAGE_ROOT": None}, "STORAGE_ROOT must be set"),
    ({"STORAGE_ROOT": "var/data"}, "absolute"),
    ({"TRUSTED_ORIGINS": "http://graveyard.example.com"}, "https://"),
    ({"TRUSTED_ORIGINS": "https://localhost"}, "https://"),
    ({"COOKIE_SECURE": "0"}, "COOKIE_SECURE"),
    ({"TRUSTED_PROXY_CIDRS": None}, "TRUSTED_PROXY_CIDRS"),
    ({"MAX_AI_CALLS_PER_DAY": None}, "MAX_AI_CALLS_PER_DAY must be set"),
    ({"MAX_TOTAL_STORAGE_BYTES": "-1"}, "MAX_TOTAL_STORAGE_BYTES must be a positive integer"),
    ({"OPENAI_API_KEY": None}, "OPENAI_API_KEY"),
])
def test_each_unsafe_production_setting_is_reported(change, fragment):
    env = {k: v for k, v in (GOOD | change).items() if v is not None}
    errors = production_config_errors(env)
    assert any(fragment in e for e in errors), errors
    joined = " ".join(errors)
    assert "SECRET-PASSWORD" not in joined and "sk-test" not in joined  # names only, never values


def test_production_app_refuses_to_start_on_an_invalid_environment(monkeypatch):
    from app.main import create_app

    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    for k in GOOD:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///x.db")
    with pytest.raises(RuntimeError, match="Production configuration invalid"):
        create_app()


def _config_in_subprocess(env_overrides):
    env = {k: v for k, v in os.environ.items() if k not in GOOD and k not in {
        "MAX_SCREENSHOTS_PER_WORKSPACE", "MAX_AI_CALLS_PER_WORKSPACE"}}
    env.update(env_overrides)
    return subprocess.run(
        [PY, "-c", "from app import config as c; print(c.MAX_SCREENSHOTS_PER_WORKSPACE, c.MAX_AI_CALLS_PER_WORKSPACE)"],
        cwd=BACKEND, env=env, capture_output=True, text=True, timeout=60,
    )


def test_app_env_typos_fail_fast_and_production_uses_smaller_quotas():
    bad = _config_in_subprocess({"APP_ENV": "prod"})
    assert bad.returncode != 0 and "APP_ENV must be" in bad.stderr
    prod = _config_in_subprocess({"APP_ENV": "production", "TRUSTED_ORIGINS": "https://graveyard.example.com"})
    assert prod.returncode == 0, prod.stderr
    assert prod.stdout.split() == ["30", "25"]
    dev = _config_in_subprocess({})
    assert dev.stdout.split() == ["500", "1000"]


# ===================================================================== dependency lock

def _norm(name: str) -> str:
    return name.lower().replace("_", "-").split("[", 1)[0]


def test_every_runtime_dependency_and_the_postgres_driver_are_pinned_in_the_lock():
    project = tomllib.loads((BACKEND / "pyproject.toml").read_text())["project"]
    declared = list(project["dependencies"]) + list(project["optional-dependencies"]["postgres"])
    lock = {}
    for line in (BACKEND / "requirements.txt").read_text().splitlines():
        if line and not line.startswith("#") and "==" in line:
            name, version = line.split("==", 1)
            lock[_norm(name)] = version.strip()
    for spec in declared:
        name, version = spec.split("==", 1)
        assert lock.get(_norm(name)) == version, spec
    assert lock.get("psycopg-binary") == lock["psycopg"]  # the [binary] extra's wheel
