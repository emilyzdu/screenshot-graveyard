"""Release preflight: refuse to start BEFORE any migration runs (P1-5).

Run as ``python -m app.preflight`` by ``deploy/start.sh``, before Alembic. It
reads only the environment and the filesystem; it never connects to or mutates
the database, and never imports ``app.config`` (whose import itself raises on
some production misconfigurations). Exit status 0 = OK, 1 = refuse to start.
Messages name settings and checks only, never their values.

Checks:
1. ``APP_ENV`` is ``production`` (the release image's default).
2. Every production setting passes ``production_checks.production_config_errors``
   (including the AI provider contract: provider, key, model, reasoning effort,
   timeout, retries).
3. ``DATABASE_URL`` parses (without echoing it).
4. ``STORAGE_ROOT`` is the intended persistent volume:
   - not under an ephemeral location (``/tmp``, ``/var/tmp``, ``/dev/shm``,
     ``/run``, ``/proc``, ``/sys``) after resolving symlinks;
   - on a mounted filesystem other than the container's root filesystem (an
     absolute path alone is not proof of persistence);
   - writable by the runtime UID where publication happens: a disposable empty
     directory is created and removed directly under the root, then a probe
     file is created, fsynced and removed inside the reserved ``.tmp/``
     directory; existing screenshot files are never opened or touched.
5. The runtime itself accepts the configuration: a separate interpreter imports
   ``app.config`` and builds the configured AI adapter (``app.ai.provider``)
   with the same environment. Neither opens a network or database connection;
   ``app.main`` (and its startup hooks) is never imported. This keeps preflight
   and runtime in agreement for every setting, not just those listed above.
"""

from __future__ import annotations

import errno
import os
import secrets
import subprocess
import sys
from collections.abc import Callable, Mapping
from pathlib import Path

from app.production_checks import production_config_errors

EPHEMERAL_PREFIXES = ("/tmp", "/var/tmp", "/dev/shm", "/run", "/proc", "/sys")
_TMP_DIRNAME = ".tmp"  # the FileStore's reserved temp directory
_BACKEND_DIR = Path(__file__).resolve().parent.parent

# Runs in a child interpreter. Prints only fixed setting-naming messages from
# app.config (RuntimeError); anything else (e.g. int('abc') -> ValueError, whose
# text contains the value) is reported generically.
_RUNTIME_PROBE = """
import sys
try:
    import app.config
    from app.ai.provider import build_configured_adapter
    build_configured_adapter()
except RuntimeError as exc:
    if type(exc) is RuntimeError:
        print(str(exc).splitlines()[0][:300] if str(exc) else '', file=sys.stderr)
    sys.exit(3)
except Exception:
    sys.exit(3)
"""


def runtime_config_errors(env: Mapping[str, str]) -> list[str]:
    """Ask the real runtime configuration code whether it accepts ``env``."""
    child_env = dict(env) | {"PYTHONDONTWRITEBYTECODE": "1"}
    try:
        r = subprocess.run([sys.executable, "-c", _RUNTIME_PROBE], cwd=_BACKEND_DIR, env=child_env,
                           capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return ["application configuration could not be checked"]
    if r.returncode == 0:
        return []
    detail = r.stderr.strip()
    # Defense in depth: never echo a configured secret even if a message did.
    secrets_in_env = [v for k, v in env.items() if v and len(v) >= 4 and any(
        t in k.upper() for t in ("KEY", "SECRET", "PASSWORD", "TOKEN", "DATABASE_URL"))]
    if not detail or "\n" in detail or any(v in detail for v in secrets_in_env):
        return ["application configuration invalid (rejected by app.config / the AI provider factory)"]
    return [f"application configuration invalid: {detail}"]


def mount_point(path: str, ismount: Callable[[str], bool] = os.path.ismount) -> str:
    """The mount point holding ``path`` (its nearest mounted ancestor)."""
    probe = os.path.realpath(path)
    while not ismount(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            return probe
        probe = parent
    return probe


def storage_errors(root: str | None, *, ismount: Callable[[str], bool] = os.path.ismount) -> list[str]:
    if not root:
        return ["STORAGE_ROOT must be set"]
    if not os.path.isabs(root):
        return ["STORAGE_ROOT must be an absolute path"]
    real = os.path.realpath(root)
    # Compare both sides resolved (e.g. macOS /tmp -> /private/tmp) and as written.
    candidates = {os.path.normpath(root), real}
    prefixes = {p for base in EPHEMERAL_PREFIXES for p in (base, os.path.realpath(base))}
    if any(c == p or c.startswith(p.rstrip("/") + "/") for c in candidates for p in prefixes):
        return ["STORAGE_ROOT must not be on an ephemeral location (/tmp, /var/tmp, /dev/shm, /run, /proc, /sys)"]
    if mount_point(real, ismount) == "/":
        return ["STORAGE_ROOT is not on a mounted persistent volume (it is on the container's root filesystem)"]
    # Publication creates workspace directories DIRECTLY under the root, so a
    # writable .tmp/ alone is not enough. Create and remove one disposable,
    # uniquely named, empty directory there; existing entries are never opened.
    try:
        os.makedirs(real, mode=0o700, exist_ok=True)
        probe_dir = os.path.join(real, f".preflight-dir.{os.getpid()}.{secrets.token_hex(4)}")
        os.mkdir(probe_dir, 0o700)
        os.rmdir(probe_dir)
    except OSError:
        return [f"STORAGE_ROOT is not writable by the runtime user (uid {os.geteuid()}): "
                "cannot create and remove a directory directly under it"]
    # The reserved .tmp must be a real directory on the root's own filesystem.
    # Refuse a symlink (or another mount) BEFORE writing the probe, so nothing
    # outside STORAGE_ROOT is ever created or removed; the probe is written
    # relative to the opened directory, never through the path again.
    contained = [f"STORAGE_ROOT/{_TMP_DIRNAME} must be a real directory inside STORAGE_ROOT "
                 "(not a symlink or another filesystem)"]
    try:
        try:
            os.mkdir(os.path.join(real, _TMP_DIRNAME), 0o700)  # never follows a symlink
        except FileExistsError:
            pass
        try:
            tmp_fd = os.open(os.path.join(real, _TMP_DIRNAME), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                return contained
            raise
        try:
            if os.fstat(tmp_fd).st_dev != os.stat(real).st_dev:
                return contained
            probe = f"preflight.{os.getpid()}.{secrets.token_hex(4)}"
            fd = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600, dir_fd=tmp_fd)
            try:
                os.write(fd, b"ok")
                os.fsync(fd)
            finally:
                os.close(fd)
                os.unlink(probe, dir_fd=tmp_fd)
        finally:
            os.close(tmp_fd)
    except OSError:
        return [f"STORAGE_ROOT is not writable by the runtime user (uid {os.geteuid()})"]
    return []


def preflight_errors(env: Mapping[str, str], *, ismount: Callable[[str], bool] = os.path.ismount) -> list[str]:
    errors: list[str] = []
    if (env.get("APP_ENV") or "").strip().lower() != "production":
        errors.append("APP_ENV must be 'production' in the release image")
    errors.extend(production_config_errors(env))
    if env.get("DATABASE_URL"):
        from app.db.url import DatabaseURLError, parse_database_url

        try:
            parse_database_url(env["DATABASE_URL"])
        except DatabaseURLError as exc:
            errors.append(str(exc))
    if not any(e.startswith("STORAGE_ROOT") for e in errors):
        errors.extend(storage_errors(env.get("STORAGE_ROOT"), ismount=ismount))
    errors.extend(runtime_config_errors(env))
    return errors


def main(env: Mapping[str, str] | None = None) -> int:
    errors = preflight_errors(os.environ if env is None else env)
    if errors:
        print("Preflight failed; nothing was migrated or started:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("Preflight passed.")
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through deploy/start.sh
    raise SystemExit(main())
