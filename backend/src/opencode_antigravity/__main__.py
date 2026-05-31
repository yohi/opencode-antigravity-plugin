"""Entry point: `python -m opencode_antigravity`."""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import sys
from typing import Any

from .antigravity_client import create_client
from .handlers import chat_completions, echo, health
from .server import StdoutWriter, apply_test_handlers, run

logger = logging.getLogger(__name__)

_ENV_DEFAULTS: dict[str, str] = {
    "OAG_REQUEST_TIMEOUT_MS": "60000",
    "OAG_STREAM_IDLE_TIMEOUT_MS": "30000",
    "OAG_MAX_AGGREGATE_TOKENS": "8192",
    "OAG_AGENT_COLDSTART_BUDGET_MS": "5000",
    "OAG_AGENT_COLDSTART_TIMEOUT_MS": "10000",
    "OAG_MAX_CONCURRENT_REQUESTS": "4",
}


def _configure_logging() -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def _apply_env_defaults() -> dict[str, str]:
    values: dict[str, str] = {}
    for key, default_value in _ENV_DEFAULTS.items():
        os.environ.setdefault(key, default_value)
        values[key] = os.environ[key]
    return values


def _read_startup_config() -> tuple[str, str, str | None]:
    mode = os.environ.get("OAG_BACKEND_MODE", "mock")
    model = os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-pro")
    api_key = os.environ.get("GEMINI_API_KEY")

    if mode == "live" and not api_key:
        sys.stderr.write("error: GEMINI_API_KEY is required for live mode\n")
        raise SystemExit(2)

    return mode, model, api_key


def _build_handlers(client: Any) -> dict[str, Any]:
    handlers: dict[str, Any] = {
        "health": health,
        "echo": echo,
        "chat.completions": functools.partial(chat_completions, client=client),
    }
    apply_test_handlers(handlers)
    return handlers


async def async_main() -> None:
    _configure_logging()
    env_values = _apply_env_defaults()
    mode, model, api_key = _read_startup_config()

    logger.info(
        "startup environment: %s",
        " ".join(f"{key}={value}" for key, value in env_values.items()),
    )
    logger.info("OAG_BACKEND_MODE=%s ANTIGRAVITY_MODEL=%s", mode, model)

    client = create_client(model=model, mode=mode, api_key=api_key)

    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    writer = StdoutWriter()

    try:
        await client.start()
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)
        await run(reader=reader, writer=writer, handlers=_build_handlers(client))
    finally:
        await client.stop()
        writer.close()


def main() -> None:
    asyncio.run(async_main())


if __name__ == "__main__":
    main()
