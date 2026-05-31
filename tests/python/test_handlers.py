from collections.abc import Awaitable
from typing import Any, cast

import pytest
from opencode_antigravity.handlers import (
    chat_completions,
    echo,
    health,
)


async def _await_completion(value: object) -> dict[str, Any]:
    return await cast(Awaitable[dict[str, Any]], value)


def test_echo() -> None:
    assert echo({"text": "hi"}) == {"text": "hi"}


def test_echo_invalid_params_list() -> None:
    # params must be a dict
    with pytest.raises(ValueError, match="params must be a dict"):
        echo(cast(dict[str, Any], cast(object, ["hi"])))


def test_health() -> None:
    result = health({})
    assert result["status"] == "ok"
    assert "version" in result


@pytest.mark.asyncio
async def test_chat_completions_returns_openai_format(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")

    result = await _await_completion(
        chat_completions(
            {
                "model": "gemini-2.5-pro",
                "messages": [{"role": "user", "content": "hi"}],
            }
        )
    )

    assert result["object"] == "chat.completion"
    assert result["model"] == "gemini-2.5-pro"
    assert result["choices"][0]["message"]["role"] == "assistant"
    assert result["choices"][0]["message"]["content"] == "[mock] hi"
    assert result["choices"][0]["finish_reason"] == "stop"
    assert result["id"].startswith("chatcmpl-")
    assert result["usage"] == {
        "prompt_tokens": 2,
        "completion_tokens": 2,
        "total_tokens": 4,
    }


@pytest.mark.asyncio
async def test_chat_completions_uses_last_user_message(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")

    result = await _await_completion(
        chat_completions(
            {
                "model": "gemini-2.5-pro",
                "messages": [
                    {"role": "user", "content": "first"},
                    {"role": "assistant", "content": "hello"},
                    {"role": "user", "content": "last"},
                ],
            }
        )
    )

    assert result["choices"][0]["message"]["content"] == "[mock] last"


def test_chat_completions_invalid_params() -> None:
    with pytest.raises(ValueError):
        chat_completions({"model": "gemini-2.5-pro"})  # messages 欠落


@pytest.mark.asyncio
async def test_chat_completions_without_user_role_is_allowed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")

    result = await _await_completion(
        chat_completions(
            {
                "model": "gemini-2.5-pro",
                "messages": [
                    {"role": "system", "content": "you are a bot"},
                    {"role": "assistant", "content": "hello"},
                ],
            }
        )
    )

    assert result["choices"][0]["message"]["content"] == "[mock] "
