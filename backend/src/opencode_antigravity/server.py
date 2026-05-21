"""stdio JSON-RPC dispatch loop."""

from __future__ import annotations

import logging
import sys
from collections.abc import Callable
from typing import Any, BinaryIO

from .handlers import chat_completions, echo, health
from .protocol import (
    JsonRpcError,
    JsonRpcInvalidRequestError,
    JsonRpcParseError,
    JsonRpcSuccess,
    format_error,
    format_response,
    parse_request,
)

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
        try:
            line = raw.decode("utf-8").rstrip("\n")
        except UnicodeDecodeError:
            logger.warning("invalid utf-8 sequence in input")
            err = JsonRpcError(id=None, code=-32700, message="Parse error: invalid utf-8")
            out = format_error(err)
            stdout.write((out + "\n").encode("utf-8"))
            stdout.flush()
            continue

        if not line:
            continue
        out = _process_one(line, table)
        if out is not None:
            stdout.write((out + "\n").encode("utf-8"))
            stdout.flush()


def _process_one(line: str, table: dict[str, Handler]) -> str | None:
    try:
        req = parse_request(line)
    except JsonRpcParseError as e:
        logger.warning("parse error: %s", e)
        return format_error(JsonRpcError(id=None, code=-32700, message=f"Parse error: {e}"))
    except JsonRpcInvalidRequestError as e:
        logger.warning("invalid request: %s", e)
        return format_error(JsonRpcError(id=None, code=-32600, message=f"Invalid Request: {e}"))
    except Exception as e:  # noqa: BLE001
        logger.exception("unexpected error during parse")
        return format_error(JsonRpcError(id=None, code=-32700, message=f"Parse error: {e}"))

    if req.id is None:
        # Notification: execute handler but do not return response
        handler = table.get(req.method)
        if handler:
            try:
                handler(req.params)
            except Exception:  # noqa: BLE001
                logger.exception("notification handler crashed: %s", req.method)
        return None

    handler = table.get(req.method)
    if handler is None:
        return format_error(
            JsonRpcError(id=req.id, code=-32601, message=f"Method not found: {req.method}")
        )

    try:
        result = handler(req.params)
    except ValueError as e:
        return format_error(JsonRpcError(id=req.id, code=-32602, message=f"Invalid params: {e}"))
    except Exception:  # noqa: BLE001
        logger.exception("handler crashed: %s", req.method)
        return format_error(JsonRpcError(id=req.id, code=-32603, message="Internal error"))

    return format_response(JsonRpcSuccess(id=req.id, result=result))


def main() -> None:
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    run(sys.stdin.buffer, sys.stdout.buffer)
