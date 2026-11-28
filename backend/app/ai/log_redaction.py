"""Keep screenshot bytes and credentials out of provider SDK logs (Batch 6A, P1-B).

The OpenAI SDK logs ``Request options: {...}`` at DEBUG on ``openai._base_client``
(the complete JSON body, including every ``data:image/...;base64,`` URL), and
the HTTP stack logs under ``httpx`` / ``httpcore``. Any handler in this
process (a root handler, uvicorn's, a test capture) would record them as soon
as those loggers are set to DEBUG, e.g. by ``OPENAI_LOG=debug``.

The protection is a LogRecord factory that only touches records whose logger
name is ``openai``/``openai.*``, ``httpx``/``httpx.*`` or ``httpcore``/
``httpcore.*``. Every other logger is untouched. For those records it:

* replaces the SDK's ``Request options`` body dump with a fixed marker;
* replaces any message that contains a data URL, a long base64 run, an API
  key (``sk-...``), a bearer token, ``api_key`` or an ``Authorization`` header
  with a fixed marker naming only the kind of content removed;
* drops attached exception tracebacks (their reprs can carry request content)
  and keeps only the exception class name.

Kept: the request line (method + URL), status codes, timing and request ids,
which carry no image or credential.

Scope: this governs records created in THIS Python process through the
standard ``logging`` module. It cannot control logs kept by the provider, a
proxy, the operating system, or a library writing to stdout directly.
"""

from __future__ import annotations

import logging
import re
import threading

_PREFIXES = ("openai", "httpx", "httpcore")
_SENSITIVE = (
    ("image data", re.compile(r"data:[\w.+-]+/[\w.+-]+;base64,", re.I)),
    ("encoded payload", re.compile(r"[A-Za-z0-9+/]{120,}={0,2}")),
    ("credential", re.compile(r"\bsk-[A-Za-z0-9_-]{6,}")),
    ("credential", re.compile(r"\bBearer\s+\S+", re.I)),
    ("credential", re.compile(r"api[_-]?key", re.I)),
    ("credential", re.compile(r"authorization", re.I)),
)
REDACTED_REQUEST_OPTIONS = "Request options: [redacted by Screenshot Graveyard: provider request body]"
_lock = threading.Lock()
_installed = False


def _in_scope(name: str) -> bool:
    return any(name == p or name.startswith(p + ".") for p in _PREFIXES)


def sanitize_record(record: logging.LogRecord) -> None:
    """Redact one in-scope record in place (idempotent)."""
    if record.exc_info:
        exc_type = record.exc_info[0]
        record.msg = f"{record.msg} [exception: {getattr(exc_type, '__name__', 'error')}; details redacted]"
        record.exc_info = None
        record.exc_text = None
    template = str(record.msg)
    if template.startswith("Request options"):
        record.msg, record.args = REDACTED_REQUEST_OPTIONS, None
        return
    try:
        text = record.getMessage()
    except Exception:  # a formatting error must not turn into a log of the raw args
        record.msg, record.args = "[provider log line redacted: unformattable]", None
        return
    for kind, pattern in _SENSITIVE:
        if pattern.search(text):
            record.msg, record.args = f"[provider log line redacted: {kind}]", None
            return


def install_provider_log_redaction() -> None:
    """Install once per process; chains to any existing record factory."""
    global _installed
    with _lock:
        if _installed:
            return
        previous = logging.getLogRecordFactory()

        def factory(*args, **kwargs):
            record = previous(*args, **kwargs)
            if _in_scope(record.name):
                sanitize_record(record)
            return record

        logging.setLogRecordFactory(factory)
        _installed = True
