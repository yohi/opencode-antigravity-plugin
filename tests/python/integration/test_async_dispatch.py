"""server.py の AsyncGenerator dispatch テスト (設計書 Section 5.1.1 sentinel `_final` 方式)。"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from typing import Any

import pytest
from opencode_antigravity import server as srv
from opencode_antigravity.protocol import format_request


async def _async_gen_handler(params: dict[str, Any]) -> AsyncGenerator[dict[str, Any], None]:
    """設計書 5.1.1: Python async generator は return value が SyntaxError のため
    sentinel `_final` を最終 yield に乗せる方式を採用する。
    """
    yield {"delta": {"role": "assistant", "content": ""}}
    yield {"delta": {"content": params["text"]}}
    yield {
        "_final": {
            "finish_reason": "stop",
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
    }


async def _sync_handler(params: dict[str, Any]) -> dict[str, Any]:
    return {"ok": True, "echo": params["text"]}


class _LineCaptureWriter:
    """asyncio.StreamWriter 互換 (write/drain/close のみ) のテストダブル。"""

    def __init__(self, buf: list[str]) -> None:
        self._buf = buf

    def write(self, data: bytes) -> None:
        text = data.decode("utf-8")
        for line in text.splitlines(keepends=False):
            if line:
                self._buf.append(line)

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None


def _feed(reader: asyncio.StreamReader, *lines: str) -> None:
    for line in lines:
        if not line.endswith("\n"):
            line += "\n"
        reader.feed_data(line.encode("utf-8"))
    reader.feed_eof()


@pytest.mark.asyncio
async def test_async_generator_handler_emits_notifications_and_final_response() -> None:
    """AsyncGenerator + stream:true → Notification を 2 件 + 最終 Response を 1 件書き出す。"""
    req = format_request("req-1", "stream.method", {"text": "abc", "stream": True})
    reader = asyncio.StreamReader()
    _feed(reader, req)

    out_lines: list[str] = []
    writer = _LineCaptureWriter(out_lines)

    await srv.run(
        reader=reader,
        writer=writer,
        handlers={"stream.method": _async_gen_handler},
    )

    parsed = [json.loads(line) for line in out_lines]
    # 通常 yield 2 件 → Notification 2 件 + 最終 Response 1 件 = 計 3 件
    assert len(parsed) == 3
    # 先頭 2 件は Notification (id を含まない)
    assert all("id" not in p for p in parsed[:2])
    assert parsed[0]["jsonrpc"] == "2.0"
    assert parsed[0]["method"] == "chat.completions.chunk"
    assert parsed[0]["params"]["request_id"] == "req-1"
    assert parsed[0]["params"]["delta"] == {"role": "assistant", "content": ""}
    assert parsed[1]["method"] == "chat.completions.chunk"
    assert parsed[1]["params"]["delta"] == {"content": "abc"}
    # 最終要素は Response (id + result)
    assert parsed[-1]["id"] == "req-1"
    assert "error" not in parsed[-1]
    assert parsed[-1]["result"]["finish_reason"] == "stop"
    assert parsed[-1]["result"]["usage"]["total_tokens"] == 2


@pytest.mark.asyncio
async def test_sync_handler_emits_response_only() -> None:
    """通常ハンドラ (sync/awaitable dict) は Phase 1 互換で 1 発の Response を返す。"""
    req = format_request("req-2", "sync.method", {"text": "ok"})
    reader = asyncio.StreamReader()
    _feed(reader, req)

    out_lines: list[str] = []
    writer = _LineCaptureWriter(out_lines)

    await srv.run(reader=reader, writer=writer, handlers={"sync.method": _sync_handler})

    parsed = [json.loads(line) for line in out_lines]
    assert len(parsed) == 1
    assert parsed[0]["id"] == "req-2"
    assert parsed[0]["result"] == {"ok": True, "echo": "ok"}


@pytest.mark.asyncio
async def test_stream_false_with_async_generator_is_contract_violation() -> None:
    """params.stream == False で AsyncGenerator が返るのは契約違反。
    設計書 5.2 に従い handlers 側で集約済 dict を返すべきだが、
    dispatch 側は -32603 で 1 発の error response を返す。
    Notification は送出しない。
    """
    req = format_request("req-3", "stream.method", {"text": "abc", "stream": False})
    reader = asyncio.StreamReader()
    _feed(reader, req)

    out_lines: list[str] = []
    writer = _LineCaptureWriter(out_lines)

    await srv.run(
        reader=reader,
        writer=writer,
        handlers={"stream.method": _async_gen_handler},
    )

    parsed = [json.loads(line) for line in out_lines]
    # Notification は出ない: 全要素に id がある (error response 含む)
    assert all("id" in p for p in parsed)
    # 1 発の error response のみ
    assert len(parsed) == 1
    assert parsed[0]["id"] == "req-3"
    assert parsed[0]["error"]["code"] == -32603
