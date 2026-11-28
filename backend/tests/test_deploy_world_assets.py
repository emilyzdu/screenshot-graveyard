"""P1-4b: Pixel World runtime art must reach the release build; source art must not.

Static build-context checks (the `.dockerignore` emulator shared with the other
P1-4 tests) plus the release-build guard `deploy/verify-world-assets.mjs`, run
against disposable trees. These do NOT build a Docker image; the real-daemon
check remains `deploy/verify-build-context.sh`.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.test_deploy_remediation import REPO, _dockerignore_rules, _excluded

ASSETS = "frontend/src/world/assets"
GUARD = REPO / "deploy" / "verify-world-assets.mjs"
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="node is required to run deploy/verify-world-assets.mjs")


def _runtime(manifest: dict) -> list[str]:
    return [a["file"] for a in manifest.get("assets", [])
            if a.get("role") != "reference-only" and "/" not in a.get("file", "/")]


def _repo_manifest() -> dict | None:
    path = REPO / ASSETS / "manifest.json"
    if (REPO / "frontend/src/world").exists():
        # Once the world is in the tree, its manifest is mandatory (never a silent pass).
        assert path.is_file(), "frontend/src/world exists but its asset manifest is missing"
    return json.loads(path.read_text()) if path.is_file() else None


# A manifest shaped like the Pixel World one (layers, buildings, sheets, a reference mockup).
SYNTHETIC = {"assets": [
    {"file": "bg-sky.png", "role": "scene"}, {"file": "ground.png", "role": "scene"},
    {"file": "building-tower.png", "role": "location:tower"}, {"file": "ghost-sheet.png", "role": "actor"},
    {"file": "lumi-sheet.png", "role": "actor"}, {"file": "selection-brackets.png", "role": "hud"},
    {"file": "../../../../docs/design/pixel-world/m-world.png", "role": "reference-only"},
]}


# --------------------------------------------------------------------- context rules
def test_every_manifest_runtime_asset_and_the_manifest_are_in_the_context():
    rules = _dockerignore_rules()
    manifest = _repo_manifest() or SYNTHETIC
    runtime = _runtime(manifest)
    assert runtime, "no runtime assets to check"
    missing = [f for f in runtime if _excluded(f"{ASSETS}/{f}", rules)]
    assert missing == [], missing
    assert not _excluded(f"{ASSETS}/manifest.json", rules)
    assert not _excluded("deploy/verify-world-assets.mjs", rules)


def test_real_manifest_has_the_expected_runtime_asset_count_when_present():
    manifest = _repo_manifest()
    if manifest is None:
        pytest.skip("Pixel World not in this tree yet (pre-merge); the synthetic manifest covers the rules")
    assert len(_runtime(manifest)) == 27


@pytest.mark.parametrize("path", [
    f"{ASSETS}/_source/building-tower-source.png",          # source art
    f"{ASSETS}/_source/building-tower.procedural-1x.png",    # fallback backup
    f"{ASSETS}/_source/nested/x.png",
    f"{ASSETS}/sub/stray.png",                               # only direct children qualify
    "frontend/.shots/tower-v2/world-1440x900.png",           # browser captures
    "frontend/src/.shots/x.png",
    "docs/design/pixel-world/m-world.png",                   # reference mockups
    "docs/screenshots/pixel-world/desktop-1440.png",         # QA screenshots
    "frontend/src/other/photo.png",                          # no broad PNG allowlist
    "frontend/src/assets/private-screenshot.png",
    "backend/var/storage/1/ab/cd/" + "c" * 64,               # private storage
    f"{ASSETS}/.env", f"{ASSETS}/world.db", f"{ASSETS}/secret.png",
    "frontend/scripts/capture-world.mjs",                    # dev tooling
])
def test_source_art_captures_and_private_data_stay_excluded(path):
    assert _excluded(path, _dockerignore_rules()), path


# --------------------------------------------------------------------- disposable combined tree
def _tree(tmp_path: Path, manifest: dict | None, present: list[str], *, source_art: bool = False) -> Path:
    src = tmp_path / "frontend" / "src"
    (src / "world" / "assets").mkdir(parents=True)
    if manifest is not None:
        (src / "world" / "assets" / "manifest.json").write_text(json.dumps(manifest))
    for f in present:
        (src / "world" / "assets" / f).write_bytes(b"\x89PNG synthetic")
    if source_art:
        (src / "world" / "assets" / "_source").mkdir()
        (src / "world" / "assets" / "_source" / "x.png").write_bytes(b"src")
    return src


def _guard(src: Path) -> subprocess.CompletedProcess:
    return subprocess.run([NODE, str(GUARD), str(src)], capture_output=True, text=True, timeout=30)


@needs_node
def test_guard_passes_with_every_runtime_asset(tmp_path):
    names = _runtime(SYNTHETIC)
    r = _guard(_tree(tmp_path, SYNTHETIC, names))
    assert r.returncode == 0, r.stderr
    assert f"OK: {len(names)} Pixel World runtime assets present" in r.stdout


@needs_node
def test_guard_fails_on_one_missing_runtime_asset(tmp_path):
    names = _runtime(SYNTHETIC)
    r = _guard(_tree(tmp_path, SYNTHETIC, [n for n in names if n != "ghost-sheet.png"]))
    assert r.returncode == 1 and "ghost-sheet.png" in r.stderr


@needs_node
def test_guard_fails_on_an_empty_asset_file(tmp_path):
    names = _runtime(SYNTHETIC)
    src = _tree(tmp_path, SYNTHETIC, names)
    (src / "world" / "assets" / "ground.png").write_bytes(b"")
    r = _guard(src)
    assert r.returncode == 1 and "ground.png" in r.stderr


@needs_node
def test_guard_fails_when_the_world_ships_without_its_manifest(tmp_path):
    r = _guard(_tree(tmp_path, None, ["ground.png"]))
    assert r.returncode == 1 and "manifest.json is missing" in r.stderr


@needs_node
def test_guard_fails_if_source_art_reached_the_build(tmp_path):
    r = _guard(_tree(tmp_path, SYNTHETIC, _runtime(SYNTHETIC), source_art=True))
    assert r.returncode == 1 and "_source" in r.stderr


@needs_node
def test_guard_passes_a_build_without_the_pixel_world(tmp_path):
    src = tmp_path / "frontend" / "src"
    src.mkdir(parents=True)
    r = _guard(src)
    assert r.returncode == 0 and "no Pixel World" in r.stdout


def test_dockerfile_runs_the_guard_before_the_frontend_build():
    text = (REPO / "Dockerfile").read_text()
    assert "COPY deploy/verify-world-assets.mjs" in text
    assert "RUN node /app/deploy/verify-world-assets.mjs src && npm run build" in text
