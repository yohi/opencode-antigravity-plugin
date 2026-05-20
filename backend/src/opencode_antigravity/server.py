"""stdio JSON-RPC dispatch loop."""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable
from typing import Any, BinaryIO

from .handlers import chat_completions, echo, health
from .protocol import JsonRpcError, JsonRpcSuccess, format_error, format_response, parse_request

logger = logging.getLogger(__name__)

Handler = Callable[[dict[str, Any]], dict[str, Any]]


def _default_handlers() -> dict[str, Handler]:
    return {
        "health": health,
        "echo": echo,
        "chat.completions": chat_completions,
    }


def run(stdin: BinaryIO, stdout: BinaryIO, handlers: dict[str, Handler] | None = None) -> None:
    """Read one NDJSON request per line, dispatch, write one response per line."""
    table = handlers if handlers is not None else _default_handlers()
    for raw in stdin:
        line = raw.decode("utf-8").rstrip("\n")
        if not line:
            continue
        out = _process_one(line, table)
        stdout.write((out + "\n").encode("utf-8"))
        stdout.flush()


def _process_one(line: str, table: dict[str, Handler]) -> str:
    try:
        req = parse_request(line)
    except ValueError as e:
        logger.warning("parse error: %s", e)
        return format_error(JsonRpcError(id=None, code=-32700, message=f"Parse error: {e}"))

    handler = table.get(req.method)
    if handler is None:
        return format_error(
            JsonRpcError(id=req.id, code=-32601, message=f"Method not found: {req.method}")
        )

    try:
        result = handler(req.params)
    except ValueError as e:
        return format_error(JsonRpcError(id=req.id, code=-32602, message=f"Invalid params: {e}"))
    except Exception as e:  # noqa: BLE001
        logger.exception("handler crashed: %s", req.method)
        return format_error(JsonRpcError(id=req.id, code=-32603, message=f"Internal error: {e}"))

    return format_response(JsonRpcSuccess(id=req.id, result=result))


def main() -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    run(sys.stdin.buffer, sys.stdout.buffer)
