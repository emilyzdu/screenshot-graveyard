"""Fail-fast validation of a production environment (deployment readiness R9).

``production_config_errors`` is a pure function over the raw environment, so it
can be tested without starting the app. ``create_app`` calls
``assert_production_config`` when ``APP_ENV=production`` and refuses to start
on any error. Messages name settings only, never their values.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from urllib.parse import urlsplit

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
_PROVIDERS = {"fake", "openai"}
_DEFAULT_PORTS = {"http": 80, "https": 443}
_REASONING_EFFORTS = {"none", "low", "medium", "high", "xhigh", "max"}


def normalize_origin(raw: str) -> str:
    """Return ``scheme://host[:port]`` (lowercase) or raise ``ValueError``.

    Accepts only what a browser can send in an ``Origin`` header: an http(s)
    scheme, a host, an optional valid port (1-65535), and at most a trailing
    ``/``. Paths, queries, fragments, credentials, wildcards and whitespace are
    rejected, and so is a backslash anywhere (some URL parsers treat it as a
    path separator, others as part of the host). A port equal to the scheme's
    default (``:443`` for https, ``:80`` for http) is dropped, because browsers
    omit it from ``Origin``; exact matching would otherwise never succeed.
    Shared by ``app.config`` (every environment) and the production
    checks, so startup and preflight agree. Messages never echo the value.
    """
    value = raw.strip()
    if (not value or "*" in value or "?" in value or "#" in value or "\\" in value
            or any(c.isspace() for c in value)):
        raise ValueError("not a browser origin")
    parts = urlsplit(value)
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc or "@" in parts.netloc:
        raise ValueError("not a browser origin")
    if parts.path not in ("", "/") or parts.query or parts.fragment or not parts.hostname:
        raise ValueError("not a browser origin")
    try:
        port = parts.port  # raises for non-numeric or out-of-range ports
    except ValueError as exc:
        raise ValueError("not a browser origin") from exc
    if port == 0 or (parts.netloc.endswith(":") and port is None):
        raise ValueError("not a browser origin")
    scheme = parts.scheme.lower()
    host = parts.netloc.lower()
    if port is not None:
        host = host.rsplit(":", 1)[0]  # the bracketed IPv6 host keeps its colons
        if port != _DEFAULT_PORTS[scheme]:
            host = f"{host}:{port}"
    return f"{scheme}://{host}"


def production_config_errors(env: Mapping[str, str]) -> list[str]:
    errors: list[str] = []

    def explicit(name: str) -> str | None:
        value = env.get(name)
        return value.strip() if value is not None and value.strip() else None

    db = explicit("DATABASE_URL")
    if db is None:
        errors.append("DATABASE_URL must be set (PostgreSQL)")
    elif not db.startswith("postgresql+psycopg://"):
        # The steering mandates PostgreSQL in production; the installed driver
        # is psycopg 3, so the SQLAlchemy URL must name it explicitly.
        errors.append("DATABASE_URL must be a PostgreSQL URL using the psycopg driver (postgresql+psycopg://)")

    storage = explicit("STORAGE_ROOT")
    if storage is None:
        errors.append("STORAGE_ROOT must be set to the persistent volume path")
    elif not os.path.isabs(storage):
        errors.append("STORAGE_ROOT must be an absolute path")

    origins = explicit("TRUSTED_ORIGINS")
    listed = [o.strip() for o in (origins or "").split(",") if o.strip()]
    if origins is None or not listed:
        errors.append("TRUSTED_ORIGINS must list at least one public https:// origin")
    else:
        for origin in listed:
            try:
                parts = urlsplit(normalize_origin(origin))
            except ValueError:
                errors.append("TRUSTED_ORIGINS must list only origins of the form https://host[:port] "
                              "(no path, query, fragment, credentials or wildcard)")
                break
            if parts.scheme != "https" or parts.hostname in _LOCAL_HOSTS:
                errors.append("TRUSTED_ORIGINS must list only public https:// origins")
                break

    if env.get("COOKIE_SECURE", "1").strip() == "0":
        errors.append("COOKIE_SECURE must not be disabled in production")

    proxies = explicit("TRUSTED_PROXY_CIDRS")
    if proxies is None:
        errors.append("TRUSTED_PROXY_CIDRS must be set explicitly (the platform proxy networks, or 'none')")
    else:
        import ipaddress

        named = [p.strip() for p in proxies.split(",") if p.strip()]
        if [p.lower() for p in named] != ["none"]:
            if not named:
                errors.append("TRUSTED_PROXY_CIDRS lists no network (use 'none' to disable forwarding)")
            for part in named:
                try:
                    net = ipaddress.ip_network(part, strict=False)
                except ValueError:
                    errors.append("TRUSTED_PROXY_CIDRS contains an invalid network (or mixes 'none' with networks)")
                    break
                if net.prefixlen == 0:
                    errors.append("TRUSTED_PROXY_CIDRS must not trust every address")
                    break

    for name in ("MAX_AI_CALLS_PER_DAY", "MAX_TOTAL_STORAGE_BYTES"):
        value = explicit(name)
        if value is None:
            errors.append(f"{name} must be set explicitly in production")
        else:
            try:
                if int(value) <= 0:
                    raise ValueError
            except ValueError:
                errors.append(f"{name} must be a positive integer")

    errors.extend(provider_config_errors(env))

    return errors


def provider_config_errors(env: Mapping[str, str]) -> list[str]:
    """The AI provider contract enforced at runtime by ``app.config`` and
    ``OpenAIVisionAdapter.from_config``, checked without importing either."""
    import math

    errors: list[str] = []
    raw_provider = env.get("AI_PROVIDER")
    provider = "fake" if raw_provider is None else raw_provider.strip().lower()
    if provider not in _PROVIDERS:
        errors.append("AI_PROVIDER must be either 'fake' or 'openai'")
    if provider == "openai":
        key = env.get("OPENAI_API_KEY")
        if key is None or not key.strip():
            errors.append("OPENAI_API_KEY must be set (non-blank) when AI_PROVIDER=openai")
        model = env.get("OPENAI_MODEL")  # unset -> the runtime default model
        if model is not None and not model.strip():
            errors.append("OPENAI_MODEL must not be blank when AI_PROVIDER=openai")
    effort = (env.get("OPENAI_REASONING_EFFORT") or "").strip().lower()
    if effort and effort not in _REASONING_EFFORTS:
        errors.append("OPENAI_REASONING_EFFORT must be one of none, low, medium, high, xhigh, max")
    timeout = env.get("AI_ADAPTER_TIMEOUT_SECONDS")
    if timeout is not None:
        try:
            seconds = float(timeout)
            if not math.isfinite(seconds) or seconds <= 0:
                raise ValueError
        except ValueError:
            errors.append("AI_ADAPTER_TIMEOUT_SECONDS must be a positive finite number")
    retries = env.get("AI_PROVIDER_MAX_RETRIES")
    if retries is not None:
        try:
            if int(retries) != 0:
                raise ValueError
        except ValueError:
            errors.append("AI_PROVIDER_MAX_RETRIES must be 0; automatic retries are disabled")
    return errors


def assert_production_config(env: Mapping[str, str] | None = None) -> None:
    errors = production_config_errors(os.environ if env is None else env)
    if errors:
        raise RuntimeError("Production configuration invalid: " + "; ".join(errors))
