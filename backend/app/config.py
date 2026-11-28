"""Application configuration, sourced from the environment (no hardcoded secrets).

`DATABASE_URL` selects the relational store. In local development it defaults to
a SQLite file; in production it is set to a managed PostgreSQL URL via the
environment. `STORAGE_ROOT` is the private file-volume path for original bytes.
Nothing here contains credentials; secrets are provided only via the environment.
"""

from __future__ import annotations

import math
import os
from pathlib import Path

# Repo root: backend/app/config.py -> parents[2] is the project root.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# Default to a local SQLite file for dev; override with a Postgres URL in prod
# by setting DATABASE_URL in the environment (e.g. postgresql+psycopg://...).
DATABASE_URL: str = os.environ.get(
    "DATABASE_URL",
    f"sqlite:///{(_REPO_ROOT / 'backend' / 'local.db').as_posix()}",
)

# Private file volume for original image bytes (never web-served). Overridable.
STORAGE_ROOT: str = os.environ.get(
    "STORAGE_ROOT",
    (_REPO_ROOT / "backend" / "var" / "storage").as_posix(),
)


def is_sqlite(url: str | None = None) -> bool:
    """Return True if the given (or configured) database URL targets SQLite."""
    return (url or DATABASE_URL).startswith("sqlite")


# ---- Workspace identity cookie (Task 1.3) ----
# Name of the cookie carrying the raw Workspace Identifier token.
WORKSPACE_COOKIE_NAME: str = os.environ.get("WORKSPACE_COOKIE_NAME", "sg_workspace")

# `Secure` flag for the workspace cookie. Defaults to True (production, same-origin
# HTTPS per the architecture steering). Set COOKIE_SECURE=0 ONLY for local HTTP
# development, where a Secure cookie would not be returned by the browser.
COOKIE_SECURE: bool = os.environ.get("COOKIE_SECURE", "1") != "0"

# Cookie max-age in seconds (~180 days). The workspace is tied to this cookie;
# there is intentionally no token-bearing recovery URL (design CORRECTION 1).
WORKSPACE_COOKIE_MAX_AGE: int = int(
    os.environ.get("WORKSPACE_COOKIE_MAX_AGE", str(180 * 24 * 60 * 60))
)


# ---- CSRF / Origin protection (Task 1.4) ----
# APP_ENV selects development vs production behavior for origin configuration.
# In production, TRUSTED_ORIGINS MUST be set explicitly; the app refuses to fall
# back to the insecure localhost development defaults (fail fast at startup).
APP_ENV: str = os.environ.get("APP_ENV", "development").strip().lower()
if APP_ENV not in {"development", "production"}:
    # A typo (e.g. "prod") must never silently select development behavior.
    raise RuntimeError("APP_ENV must be 'development' or 'production'")
IS_PRODUCTION: bool = APP_ENV == "production"

# Dev-only default trusted origins (localhost same-origin). NEVER used in prod.
_DEV_DEFAULT_ORIGINS = (
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:8000,http://127.0.0.1:8000"
)


def _parse_origins(raw: str) -> tuple[str, ...]:
    # Normalize to lowercase scheme://host[:port], strip trailing slash. Exact
    # matching only — no wildcard, no subdomain/prefix matching. An entry that
    # no browser could send as an Origin (path, query, fragment, credentials,
    # invalid port, wildcard) fails startup in every environment.
    from app.production_checks import normalize_origin

    origins = []
    for entry in (o for o in raw.split(",") if o.strip()):
        try:
            origins.append(normalize_origin(entry))
        except ValueError as exc:
            raise RuntimeError(
                "TRUSTED_ORIGINS entries must be scheme://host[:port] origins (no path, query, "
                "fragment, credentials or wildcard)."
            ) from exc
    return tuple(origins)


def _resolve_trusted_origins() -> tuple[str, ...]:
    raw = os.environ.get("TRUSTED_ORIGINS")
    if raw is None or not raw.strip():
        if APP_ENV == "production":
            raise RuntimeError(
                "TRUSTED_ORIGINS must be set explicitly in production (APP_ENV="
                "production). Refusing to fall back to insecure localhost "
                "development defaults."
            )
        raw = _DEV_DEFAULT_ORIGINS
    origins = _parse_origins(raw)
    if not origins:
        # e.g. "," or " , ": an explicit setting that lists nothing is a mistake,
        # never a silent "no trusted origins".
        raise RuntimeError("TRUSTED_ORIGINS must list at least one origin.")
    # Defense in depth: never allow a wildcard entry.
    if any(o == "*" or "*" in o for o in origins):
        raise RuntimeError("TRUSTED_ORIGINS must not contain a wildcard.")
    return origins


TRUSTED_ORIGINS: tuple[str, ...] = _resolve_trusted_origins()

# Required custom header on state-changing requests. Browsers forbid setting
# custom headers on simple cross-site form submissions, so a cross-site attacker
# cannot forge it. Value is checked for presence only (any non-empty value).
CSRF_HEADER_NAME: str = os.environ.get("CSRF_HEADER_NAME", "X-Requested-With")


# ---- Rate limiting, size, and quota gates (Task 1.5) ----
# All in-process (no distributed limiter); values are env-overridable defaults,
# chosen conservatively for a solo-dev public hobby deployment. They are NOT
# shared across workers/instances (see RateLimiter docstring).

# Token-bucket rate limit per workspace: capacity (burst) and refill rate.
RATE_LIMIT_CAPACITY: int = int(os.environ.get("RATE_LIMIT_CAPACITY", "60"))
RATE_LIMIT_REFILL_PER_SEC: float = float(
    os.environ.get("RATE_LIMIT_REFILL_PER_SEC", "1.0")
)

# Maximum accepted request payload size in bytes (15 MB per file, Req 1.5 / A5).
# Applied as a request-body cap; per-file validation also enforces 15 MB later.
MAX_UPLOAD_BYTES: int = int(os.environ.get("MAX_UPLOAD_BYTES", str(15 * 1024 * 1024)))

# Maximum number of files accepted in a single upload batch.
MAX_FILES_PER_BATCH: int = int(os.environ.get("MAX_FILES_PER_BATCH", "20"))

# Aggregate maximum size of an ENTIRE request body (all multipart parts +
# envelope), distinct from the per-file 15 MB cap. Sized for a full batch:
# MAX_FILES_PER_BATCH * MAX_UPLOAD_BYTES plus a margin for multipart boundaries
# and headers. This bounds parsing/spooling even when Content-Length is absent,
# false, or the request is chunked. Enforced on ACTUAL bytes received.
_MULTIPART_OVERHEAD_MARGIN = 1 * 1024 * 1024  # 1 MB for boundaries/headers
MAX_REQUEST_BYTES: int = int(
    os.environ.get(
        "MAX_REQUEST_BYTES",
        str(MAX_FILES_PER_BATCH * MAX_UPLOAD_BYTES + _MULTIPART_OVERHEAD_MARGIN),
    )
)

# Per-workspace DB quota counters. Production uses smaller public defaults
# (deployment readiness R7); an explicit environment value always wins.
MAX_SCREENSHOTS_PER_WORKSPACE: int = int(
    os.environ.get("MAX_SCREENSHOTS_PER_WORKSPACE", "30" if IS_PRODUCTION else "500")
)
MAX_AI_CALLS_PER_WORKSPACE: int = int(
    os.environ.get("MAX_AI_CALLS_PER_WORKSPACE", "25" if IS_PRODUCTION else "1000")
)

# ---- Global (cross-workspace) protections (deployment readiness R5, R8) ----
# Per-workspace quotas alone do not bound a public app: anyone can mint a new
# workspace. These limits count across ALL workspaces, persist in the database
# (``global_counter``) and are enforced under a database row lock.
#
# MAX_AI_CALLS_PER_DAY is an APPLICATION-SIDE REQUEST QUOTA: the number of new
# AI operations (each is at most one provider request) accepted per UTC day. It
# is NOT a verified financial cap: the only hard spending cap is the provider
# account's own limit (prepaid credits / project budget), which this app cannot
# read or verify. Production requires it to be set explicitly.
MAX_AI_CALLS_PER_DAY: int = int(os.environ.get("MAX_AI_CALLS_PER_DAY", "10000"))
# Total bytes of stored original screenshots across all workspaces. New bytes
# are refused once reached; existing files are never deleted. Production
# requires it to be set explicitly.
MAX_TOTAL_STORAGE_BYTES: int = int(
    os.environ.get("MAX_TOTAL_STORAGE_BYTES", str(50 * 1024**3))
)
# Uploads are refused when the storage volume has less free space than this.
STORAGE_MIN_FREE_BYTES: int = int(
    os.environ.get("STORAGE_MIN_FREE_BYTES", str(256 * 1024**2))
)
for _name in ("MAX_SCREENSHOTS_PER_WORKSPACE", "MAX_AI_CALLS_PER_WORKSPACE",
              "MAX_AI_CALLS_PER_DAY", "MAX_TOTAL_STORAGE_BYTES"):
    if globals()[_name] <= 0:
        raise RuntimeError(f"{_name} must be a positive integer")
if STORAGE_MIN_FREE_BYTES < 0:
    raise RuntimeError("STORAGE_MIN_FREE_BYTES must not be negative")


# ---- Trusted reverse proxy (deployment readiness R4) ----
# The per-IP rate limiter uses the direct peer address. Only when that peer is
# inside one of these networks (the platform's own proxy) is X-Forwarded-For
# consulted, and then only its right-most entry that is NOT itself a trusted
# proxy. Empty = never trust forwarding headers (local development). Production
# requires an explicit value; "none" states that no proxy is in front.
def _parse_proxy_networks(raw: str | None):
    """``None``/unset (development) or exactly ``none`` -> no trusted proxy.

    Otherwise one or more CIDRs. A value that lists nothing (``","``), mixes
    ``none`` with networks, contains an invalid network, or trusts every address
    (prefix length 0, e.g. ``0.0.0.0/0``) is rejected: it would either silently
    disable proxy handling or let any client forge its address.
    """
    import ipaddress

    if raw is None or not raw.strip():
        return ()
    parts = [p.strip() for p in raw.split(",")]
    named = [p for p in parts if p]
    if [p.lower() for p in named] == ["none"]:
        return ()
    if not named:
        raise RuntimeError("TRUSTED_PROXY_CIDRS lists no network (use 'none' to disable)")
    nets = []
    for part in named:
        if part.lower() == "none":
            raise RuntimeError("TRUSTED_PROXY_CIDRS cannot combine 'none' with networks")
        try:
            net = ipaddress.ip_network(part, strict=False)
        except ValueError as exc:
            raise RuntimeError("TRUSTED_PROXY_CIDRS contains an invalid network") from exc
        if net.prefixlen == 0:
            raise RuntimeError("TRUSTED_PROXY_CIDRS must not trust every address")
        nets.append(net)
    return tuple(nets)


TRUSTED_PROXY_NETWORKS = _parse_proxy_networks(os.environ.get("TRUSTED_PROXY_CIDRS"))

def _positive_finite_float(raw: str, *, setting: str) -> float:
    """Parse a required-positive finite duration at startup.

    A zero, negative, NaN, or infinite adapter timeout would silently disable
    the bounded-call safety contract, so configuration fails fast instead.
    """
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{setting} must be a positive finite number") from exc
    if not math.isfinite(value) or value <= 0:
        raise RuntimeError(f"{setting} must be a positive finite number")
    return value


# Per-call wall-clock timeout (seconds) for any AIAdapter implementation
# (design CORRECTION 4). On timeout the adapter raises AIAdapterTimeoutError and
# the calling service marks the operation failed/uncertain with sources intact.
AI_ADAPTER_TIMEOUT_SECONDS: float = _positive_finite_float(
    os.environ.get("AI_ADAPTER_TIMEOUT_SECONDS", "30"),
    setting="AI_ADAPTER_TIMEOUT_SECONDS",
)

# ---- AI provider (Task 2.9a) ----
# The fake is deliberately the safe default: it is deterministic, network-free,
# and requires no credential.  A real provider is an explicit deployment choice.
AI_PROVIDER: str = os.environ.get("AI_PROVIDER", "fake").strip().lower()
if AI_PROVIDER not in {"fake", "openai"}:
    raise RuntimeError("AI_PROVIDER must be either 'fake' or 'openai'")

# Do not validate this in fake mode: local/unit-test usage must never require a
# provider credential.  The provider factory validates it before real mode starts.
OPENAI_API_KEY: str | None = os.environ.get("OPENAI_API_KEY")
# A documented vision-capable model is configurable rather than embedded in the
# adapter call. Deployments should pin a currently supported model explicitly.
OPENAI_MODEL: str = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini").strip()


def _positive_int(raw: str, *, setting: str) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{setting} must be a positive integer") from exc
    if value <= 0:
        raise RuntimeError(f"{setting} must be a positive integer")
    return value


# These caps apply before Base64 expansion.  They deliberately sit below the
# Vault upload limit; a safely stored original can still be too large to send.
AI_MAX_INPUT_IMAGE_BYTES: int = _positive_int(
    os.environ.get("AI_MAX_INPUT_IMAGE_BYTES", str(4 * 1024 * 1024)),
    setting="AI_MAX_INPUT_IMAGE_BYTES",
)
AI_MAX_STUDY_INPUT_BYTES: int = _positive_int(
    os.environ.get("AI_MAX_STUDY_INPUT_BYTES", str(12 * 1024 * 1024)),
    setting="AI_MAX_STUDY_INPUT_BYTES",
)
AI_MAX_STUDY_IMAGE_COUNT: int = _positive_int(
    os.environ.get("AI_MAX_STUDY_IMAGE_COUNT", "12"),
    setting="AI_MAX_STUDY_IMAGE_COUNT",
)
AI_CLASSIFICATION_MAX_OUTPUT_TOKENS: int = _positive_int(
    os.environ.get("AI_CLASSIFICATION_MAX_OUTPUT_TOKENS", "600"),
    setting="AI_CLASSIFICATION_MAX_OUTPUT_TOKENS",
)
# Upper bound (characters) on user-supplied AI Redo regeneration instructions.
# Instructions are untrusted text; the bound limits provider cost and abuse.
AI_REDO_INSTRUCTIONS_MAX_CHARS: int = _positive_int(
    os.environ.get("AI_REDO_INSTRUCTIONS_MAX_CHARS", "1000"),
    setting="AI_REDO_INSTRUCTIONS_MAX_CHARS",
)
AI_STUDY_NOTE_MAX_OUTPUT_TOKENS: int = _positive_int(
    os.environ.get("AI_STUDY_NOTE_MAX_OUTPUT_TOKENS", "2000"),
    setting="AI_STUDY_NOTE_MAX_OUTPUT_TOKENS",
)
AI_EVENT_DRAFT_MAX_OUTPUT_TOKENS: int = _positive_int(
    os.environ.get("AI_EVENT_DRAFT_MAX_OUTPUT_TOKENS", "1200"),
    setting="AI_EVENT_DRAFT_MAX_OUTPUT_TOKENS",
)
# Optional, only for reasoning models (e.g. ``gpt-6-luna``). Unset means the
# ``reasoning`` parameter is not sent at all, which non-reasoning models such as
# the default ``gpt-4.1-mini`` require. ``none`` keeps every output token for
# the structured result.
OPENAI_REASONING_EFFORT: str | None = (os.environ.get("OPENAI_REASONING_EFFORT") or "").strip().lower() or None
if OPENAI_REASONING_EFFORT is not None and OPENAI_REASONING_EFFORT not in {
    "none", "low", "medium", "high", "xhigh", "max"
}:
    raise RuntimeError("OPENAI_REASONING_EFFORT must be one of none, low, medium, high, xhigh, max")
AI_PROVIDER_MAX_RETRIES: int = int(os.environ.get("AI_PROVIDER_MAX_RETRIES", "0"))
if AI_PROVIDER_MAX_RETRIES != 0:
    raise RuntimeError("AI_PROVIDER_MAX_RETRIES must be 0; automatic retries are disabled")

# BackgroundTasks are intentionally non-durable.  Startup and the managed
# lifespan loop recover only operations older than this conservative window;
# the normal adapter timeout is much shorter.  Values are server-side and
# validated like the adapter timeout so an invalid setting cannot make every
# fresh request look stale or disable recovery entirely.
STALE_PENDING_OPERATION_SECONDS: float = _positive_finite_float(
    os.environ.get("STALE_PENDING_OPERATION_SECONDS", "300"),
    setting="STALE_PENDING_OPERATION_SECONDS",
)
OPERATION_RECOVERY_INTERVAL_SECONDS: float = _positive_finite_float(
    os.environ.get("OPERATION_RECOVERY_INTERVAL_SECONDS", "60"),
    setting="OPERATION_RECOVERY_INTERVAL_SECONDS",
)


# ---- Upload image validation (Task 1.7) ----
# Supported image formats (content-authoritative; A5 / Req 1.2-1.3). Declared
# filename extension and MIME type are HINTS only, never the sole reject reason.
SUPPORTED_IMAGE_FORMATS: tuple[str, ...] = ("PNG", "JPEG", "WEBP")

# Decompression-bomb guard (design CORRECTION 3): max single dimension and total
# megapixels. 40 MP comfortably exceeds legitimate screenshots while blocking bombs.
MAX_IMAGE_DIMENSION_PX: int = int(os.environ.get("MAX_IMAGE_DIMENSION_PX", "12000"))
MAX_IMAGE_MEGAPIXELS: float = float(os.environ.get("MAX_IMAGE_MEGAPIXELS", "40"))
