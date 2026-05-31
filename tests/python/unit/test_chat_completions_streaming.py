from __future__ import annotations

from collections.abc import AsyncGenerator, Awaitable
from typing import Any, cast

import pytest
from opencode_antigravity.antigravity_client import MockAntigravityClient
from opencode_antigravity.errors import SdkApiError
from opencode_antigravity.handlers import chat_completions


async def _await_completion(value: object) -> dict[str, Any]:
    return await cast(Awaitable[dict[str, Any]], value)


async def _collect_stream(value: object) -> list[dict[str, Any]]:
    agen = cast(AsyncGenerator[dict[str, Any], None], value)
    items: list[dict[str, Any]] = []
    async for item in agen:
        items.append(item)
    return items


@pytest.mark.asyncio
async def test_chat_completions_stream_true_yields_chunks_and_final_sentinel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        params = {
            "model": "gemini-2.5-pro",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": True,
        }

        result = chat_completions(params, client=client)
        chunks = await _collect_stream(result)

        final = chunks[-1]["_final"]
        normal_chunks = chunks[:-1]

        assert normal_chunks[0] == {"delta": {"role": "assistant", "content": ""}}
        assert {"delta": {"content": "[mock] "}} in normal_chunks
        assert {"delta": {"content": "hello"}} in normal_chunks
        assert all("_final" not in chunk for chunk in normal_chunks)
        assert final["finish_reason"] == "stop"
        assert final["usage"] == {
            "prompt_tokens": 5,
            "completion_tokens": 12,
            "total_tokens": 17,
        }
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_chat_completions_stream_false_returns_aggregated_dict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        params = {
            "model": "gemini-2.5-pro",
            "messages": [{"role": "user", "content": "hello"}],
            "stream": False,
        }

        result = await _await_completion(chat_completions(params, client=client))

        assert result["object"] == "chat.completion"
        assert result["model"] == "gemini-2.5-pro"
        assert result["choices"][0]["message"] == {
            "role": "assistant",
            "content": "[mock] hello",
        }
        assert result["choices"][0]["finish_reason"] == "stop"
        assert result["usage"] == {
            "prompt_tokens": 5,
            "completion_tokens": 12,
            "total_tokens": 17,
        }
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_chat_completions_stream_omitted_returns_aggregated_dict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")
    result = await _await_completion(
        chat_completions(
            {"model": "gemini-2.5-pro", "messages": [{"role": "user", "content": "hello"}]},
        )
    )

    assert result["choices"][0]["message"]["content"] == "[mock] hello"


@pytest.mark.asyncio
async def test_chat_completions_empty_messages_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")

    with pytest.raises(ValueError):
        chat_completions({"model": "gemini-2.5-pro", "messages": [], "stream": True})


@pytest.mark.asyncio
async def test_chat_completions_unknown_model_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")

    with pytest.raises(ValueError, match=r"model must be gemini-2\.5-pro"):
        chat_completions(
            {
                "model": "wrong-model",
                "messages": [{"role": "user", "content": "hello"}],
                "stream": True,
            },
        )


@pytest.mark.asyncio
async def test_chat_completions_invalid_role_raises_before_agent_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")
    client = MockAntigravityClient(model="gemini-2.5-pro")

    with pytest.raises(ValueError, match="unsupported role"):
        chat_completions(
            {
                "model": "gemini-2.5-pro",
                "messages": [{"role": "tool", "content": "hello"}],
                "stream": True,
            },
            client=client,
        )

    assert client.agent_enter_attempt_count == 0


@pytest.mark.asyncio
async def test_chat_completions_aggregate_cap_raises_sdk_api_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTIGRAVITY_MODEL", "gemini-2.5-pro")
    monkeypatch.setenv("OAG_MAX_AGGREGATE_TOKENS", "1")
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        with pytest.raises(SdkApiError):
            await _await_completion(
                chat_completions(
                    {
                        "model": "gemini-2.5-pro",
                        "messages": [{"role": "user", "content": "hello"}],
                        "stream": False,
                    },
                    client=client,
                )
            )
    finally:
        await client.stop()
