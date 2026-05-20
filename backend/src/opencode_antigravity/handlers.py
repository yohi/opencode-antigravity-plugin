"""MVP handlers: echo / health / chat.completions."""

from __future__ import annotations

import logging
import secrets
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from . import __version__

logger = logging.getLogger(__name__)


def echo(params: dict[str, Any]) -> dict[str, Any]:
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


def chat_completions(params: dict[str, Any]) -> dict[str, Any]:
    try:
        req = _ChatRequest.model_validate(params)
    except ValidationError as e:
        raise ValueError(f"invalid chat.completions params: {e}") from e

    last_user_msg = next(
        (m for m in reversed(req.messages) if m.role == "user"),
        req.messages[-1],
    )
    reply = f"[echo] {last_user_msg.content}"
    return {
        "id": f"chatcmpl-{secrets.token_hex(12)}",
        "object": "chat.completion",
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": reply},
                "finish_reason": "stop",
            }
        ],
    }
