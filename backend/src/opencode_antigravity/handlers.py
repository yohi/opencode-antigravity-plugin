"""MVP handlers: echo / health / chat.completions."""

from __future__ import annotations

import os
import secrets
from collections.abc import AsyncGenerator, Awaitable
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from . import __version__
from .antigravity_client import AntigravityClientBase, MockAntigravityClient
from .errors import SdkApiError
from .prompt_folding import fold_messages_to_prompt


def echo(params: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(params, dict):
        raise ValueError("params must be a dict")
    text = params.get("text", "")
    return {"text": text}


def health(_params: dict[str, Any]) -> dict[str, Any]:
    return {"status": "ok", "version": __version__}


class _ChatMessage(BaseModel):
    role: str
    content: str


class _ChatRequest(BaseModel):
    model: str
    messages: list[_ChatMessage] = Field(min_length=1)
    stream: bool = False


def chat_completions(
    params: dict[str, Any],
    *,
    client: AntigravityClientBase | None = None,
) -> AsyncGenerator[dict[str, Any], None] | Awaitable[dict[str, Any]]:
    if not isinstance(params, dict):
        raise ValueError("params must be a dict")

    try:
        req = _ChatRequest.model_validate(params)
    except ValidationError as e:
        raise ValueError(f"invalid chat.completions params: {e}") from e

    allowed_model = os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-pro")
    if req.model != allowed_model:
        raise ValueError(f"model must be {allowed_model}")

    messages = [message.model_dump() for message in req.messages]
    # Call for early role-validation side-effect only; return value not used here.
    fold_messages_to_prompt(messages)

    selected_client = client if client is not None else MockAntigravityClient(model=allowed_model)
    if req.stream:
        return _stream_impl(req, messages, selected_client)
    return _aggregate_impl(req, messages, selected_client)


async def _stream_impl(
    req: _ChatRequest,
    messages: list[dict[str, Any]],
    client: AntigravityClientBase,
) -> AsyncGenerator[dict[str, Any], None]:
    yield {"delta": {"role": "assistant", "content": ""}}
    completion_tokens = 0

    async for token in client.stream_chat(messages):
        yield {"delta": {"content": token}}
        completion_tokens += len(str(token))

    prompt_tokens = _count_prompt_tokens(req)
    yield {
        "_final": {
            "finish_reason": "stop",
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        }
    }


async def _aggregate_impl(
    req: _ChatRequest,
    messages: list[dict[str, Any]],
    client: AntigravityClientBase,
) -> dict[str, Any]:
    max_tokens = _max_aggregate_tokens()
    buffer: list[str] = []
    completion_tokens = 0
    final_meta: dict[str, Any] = {}

    agen = _stream_impl(req, messages, client)
    try:
        async for item in agen:
            if "_final" in item:
                final_meta = item["_final"]
                break

            delta = item.get("delta", {})
            content = delta.get("content") if isinstance(delta, dict) else None
            if content:
                content_length = len(str(content))
                completion_tokens += content_length
                if completion_tokens > max_tokens:
                    raise SdkApiError(
                        f"aggregation exceeded OAG_MAX_AGGREGATE_TOKENS (N={max_tokens})"
                    )
                buffer.append(str(content))
    finally:
        await agen.aclose()

    usage = final_meta.get("usage")
    if not isinstance(usage, dict):
        prompt_tokens = _count_prompt_tokens(req)
        usage = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        }

    return {
        "id": _new_chatcmpl_id(),
        "object": "chat.completion",
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": "".join(buffer)},
                "finish_reason": final_meta.get("finish_reason", "stop"),
            }
        ],
        "usage": usage,
    }


def _max_aggregate_tokens() -> int:
    raw_value = os.environ.get("OAG_MAX_AGGREGATE_TOKENS", "8192")
    try:
        max_tokens = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"OAG_MAX_AGGREGATE_TOKENS must be an integer, got {raw_value!r}") from exc
    if max_tokens < 0:
        raise ValueError(f"OAG_MAX_AGGREGATE_TOKENS must be non-negative, got {max_tokens}")
    return max_tokens


def _count_prompt_tokens(req: _ChatRequest) -> int:
    # NOTE: character-length approximation; not actual subword token count.
    return sum(len(message.content) for message in req.messages)


def _new_chatcmpl_id() -> str:
    return f"chatcmpl-{secrets.token_hex(12)}"
