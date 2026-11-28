"""The single seam for the external-tool transport (mirrors ``app.ai.provider``).

``EXTERNAL_TOOLS_MODE=off`` (default): no transport; every tool route answers
"not enabled" and nothing is planned or executed. ``fake``: the network-free
fake. ``composio``: the REST transport, which fails closed at startup without
an API key. There is no silent fallback between modes.
"""
from __future__ import annotations

from app import config
from app.tools.transport import ToolTransport

_transport: ToolTransport | None = None


def build_configured_transport() -> ToolTransport | None:
    mode = config.EXTERNAL_TOOLS_MODE
    if mode == "off":
        return None
    if mode == "fake":
        from app.tools.fake_transport import shared_fake_transport

        return shared_fake_transport()
    if mode == "composio":
        if not config.COMPOSIO_API_KEY or not config.COMPOSIO_API_KEY.strip():
            raise RuntimeError("EXTERNAL_TOOLS_MODE=composio requires COMPOSIO_API_KEY")
        if config.COMPOSIO_CALLBACK_URL and not (
            config.COMPOSIO_CALLBACK_URL.startswith("https://")
            or (not config.IS_PRODUCTION and config.COMPOSIO_CALLBACK_URL.startswith("http://localhost"))
        ):
            raise RuntimeError("COMPOSIO_CALLBACK_URL must be https (http://localhost only in development)")
        from app.tools.composio_http import ComposioHttpTransport

        return ComposioHttpTransport(
            api_key=config.COMPOSIO_API_KEY,
            base_url=config.COMPOSIO_BASE_URL,
            timeout_seconds=config.COMPOSIO_TIMEOUT_SECONDS,
        )
    raise RuntimeError("unsupported EXTERNAL_TOOLS_MODE")


def configure_tool_transport() -> ToolTransport | None:
    set_tool_transport(build_configured_transport())
    return _transport


def get_tool_transport() -> ToolTransport | None:
    """The active transport, or None when external tools are off."""
    return _transport


def set_tool_transport(transport: ToolTransport | None) -> None:
    global _transport
    _transport = transport
