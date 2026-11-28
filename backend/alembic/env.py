"""Alembic environment: targets the app's models and env-based DATABASE_URL.

The connection URL comes from `app.config.DATABASE_URL` (environment), never from
a hardcoded value in alembic.ini. `target_metadata` is the app's declarative
`Base.metadata`, with `render_as_batch` enabled for SQLite compatibility.
"""

from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, pool

# Make the backend package importable when alembic runs from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config as app_config  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db import models  # noqa: E402,F401  (registers mappers)
from app.db.url import parse_database_url, redact  # noqa: E402

config = context.config


def _resolve_url() -> str:
    """Resolve the database URL with correct precedence (no hardcoded secret).

    1. A URL explicitly set on the Alembic config by the caller
       (e.g. tests via `cfg.set_main_option("sqlalchemy.url", ...)`).
    2. Otherwise the live `DATABASE_URL` environment variable.
    3. Otherwise the app's configured default (import-time constant).
    """
    import os

    caller_url = config.get_main_option("sqlalchemy.url")
    if caller_url:
        return caller_url
    return os.environ.get("DATABASE_URL", app_config.DATABASE_URL)


# Parsed ONCE and passed to SQLAlchemy as a URL object. It is deliberately NOT
# written back with `config.set_main_option`: Alembic's ConfigParser treats "%"
# as interpolation, so a URL-encoded password (e.g. "p%40ss") would fail there.
# A malformed URL raises a generic error that does not echo the value.
_DB_URL = parse_database_url(_resolve_url())

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _is_sqlite() -> bool:
    return _DB_URL.get_backend_name() == "sqlite"


def run_migrations_offline() -> None:
    context.configure(
        url=_DB_URL,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=_is_sqlite(),
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(_DB_URL, poolclass=pool.NullPool)
    try:
        connection = connectable.connect()
    except Exception as exc:
        # Never let a connection failure print the password: re-raise with the
        # driver's message redacted and the original traceback suppressed.
        raise RuntimeError(
            f"Database connection failed ({type(exc).__name__}): {redact(str(exc), _DB_URL)}"
        ) from None
    with connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=_is_sqlite(),
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
