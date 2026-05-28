"""JSON-RPC 2.0 protocol types and serialization (pydantic-backed)."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

MAX_MESSAGE_BYTES = 1024 * 1024


class JsonRpcModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class JsonRpcRequest(JsonRpcModel):
    jsonrpc: Literal["2.0"]
    id: int | str | None = None
    method: str
    params: list[Any] | dict[str, Any] = Field(default_factory=dict)


class JsonRpcSuccess(JsonRpcModel):
    id: int | str
    result: Any


class JsonRpcError(JsonRpcModel):
    id: int | str | None
    code: int
    message: str
    data: Any | None = None


class JsonRpcParseError(ValueError):
    """JSON-RPC parse error (-32700)."""
    code = -32700


class JsonRpcInvalidRequestError(ValueError):
    """JSON-RPC invalid request (-32600)."""
    code = -32600


def parse_request(line: str) -> JsonRpcRequest:
    """Parse one NDJSON line into a JsonRpcRequest. Raises specific errors on invalidity."""
    if len(line) > MAX_MESSAGE_BYTES or len(line.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise JsonRpcInvalidRequestError("inbound message exceeds 1 MB")

    try:
        obj = json.loads(line)
    except json.JSONDecodeError as e:
        raise JsonRpcParseError(f"parse error: {e}") from e

    if not isinstance(obj, dict):
        raise JsonRpcInvalidRequestError("invalid request shape: expected object")

    if obj.get("jsonrpc") != "2.0":
        raise JsonRpcInvalidRequestError("invalid jsonrpc version (expected '2.0')")

    try:
        return JsonRpcRequest.model_validate(obj)
    except ValidationError as e:
        raise JsonRpcInvalidRequestError(f"invalid request shape: {e}") from e


def format_response(success: JsonRpcSuccess) -> str:
    return json.dumps(
        {"jsonrpc": "2.0", "id": success.id, "result": success.result},
        separators=(",", ":"),
        ensure_ascii=False,
    )


def format_notification(method: str, params: dict[str, Any]) -> str:
    """Format a JSON-RPC 2.0 Notification as one NDJSON line."""
    payload = {"jsonrpc": "2.0", "method": method, "params": params}
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    if len(line.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise JsonRpcInvalidRequestError(f"notification exceeds {MAX_MESSAGE_BYTES} bytes")
    return line


def format_error(err: JsonRpcError) -> str:
    body: dict[str, Any] = {"code": err.code, "message": err.message}
    if err.data is not None:
        body["data"] = err.data
    return json.dumps(
        {"jsonrpc": "2.0", "id": err.id, "error": body},
        separators=(",", ":"),
        ensure_ascii=False,
    )
