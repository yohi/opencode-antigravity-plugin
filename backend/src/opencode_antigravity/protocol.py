"""JSON-RPC 2.0 protocol types and serialization (pydantic-backed)."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError


class JsonRpcRequest(BaseModel):
    jsonrpc: Literal["2.0"]
    id: int | str
    method: str
    params: list[Any] | dict[str, Any] = Field(default_factory=dict)


class JsonRpcSuccess(BaseModel):
    id: int | str
    result: Any


class JsonRpcError(BaseModel):
    id: int | str | None
    code: int
    message: str
    data: Any | None = None


def parse_request(line: str) -> JsonRpcRequest:
    """Parse one NDJSON line into a JsonRpcRequest. Raises ValueError on invalidity."""
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as e:
        raise ValueError(f"parse error: {e}") from e
    if not isinstance(obj, dict) or obj.get("jsonrpc") != "2.0":
        raise ValueError("invalid jsonrpc version (expected '2.0')")
    try:
        return JsonRpcRequest.model_validate(obj)
    except ValidationError as e:
        raise ValueError(f"invalid request shape: {e}") from e


def format_response(success: JsonRpcSuccess) -> str:
    return json.dumps(
        {"jsonrpc": "2.0", "id": success.id, "result": success.result},
        separators=(",", ":"),
        ensure_ascii=False,
    )


def format_error(err: JsonRpcError) -> str:
    body: dict[str, Any] = {"code": err.code, "message": err.message}
    if err.data is not None:
        body["data"] = err.data
    return json.dumps(
        {"jsonrpc": "2.0", "id": err.id, "error": body},
        separators=(",", ":"),
        ensure_ascii=False,
    )
