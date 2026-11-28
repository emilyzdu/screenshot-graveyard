"""Safe handling of ``DATABASE_URL`` (deployment foundation P1-3).

* The URL is parsed with SQLAlchemy's ``make_url`` and passed on as a ``URL``
  object, never written into Alembic's ConfigParser (which treats ``%`` as
  interpolation, so a URL-encoded password such as ``p%40ss`` would fail).
* A URL that cannot be parsed raises a generic error WITHOUT echoing the input
  (SQLAlchemy's own parse error repeats the whole string, password included).
* ``masked`` renders a URL with its password hidden; ``redact`` removes the
  password (raw and URL-encoded) from any text before it is logged.
"""

from __future__ import annotations

from urllib.parse import quote, quote_plus

from sqlalchemy.engine import URL, make_url


class DatabaseURLError(RuntimeError):
    """``DATABASE_URL`` is missing or malformed (the value is never included)."""


def parse_database_url(raw: str | URL | None) -> URL:
    if isinstance(raw, URL):
        return raw
    if raw is None or not str(raw).strip():
        raise DatabaseURLError("DATABASE_URL is not set")
    try:
        return make_url(str(raw).strip())
    except Exception:
        raise DatabaseURLError("DATABASE_URL is not a valid database URL") from None


def masked(url: URL) -> str:
    return url.render_as_string(hide_password=True)


def redact(text: str, url: URL | str | None) -> str:
    """Remove the URL's password (and its encoded forms) from ``text``."""
    if url is None:
        return text
    try:
        parsed = parse_database_url(url)
    except DatabaseURLError:
        return text
    password = parsed.password
    if not password:
        return text
    for form in {str(password), quote(str(password), safe=""), quote_plus(str(password))}:
        if form:
            text = text.replace(form, "***")
    return text
