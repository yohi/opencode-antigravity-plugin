import json

import pytest
from opencode_antigravity.protocol import (
    MAX_MESSAGE_BYTES,
    JsonRpcInvalidRequestError,
    format_notification,
)


def test_format_notification_basic() -> None:
    out = format_notification(
        method="chat.completions.chunk",
        params={"request_id": "abc", "delta": {"content": "x"}},
    )
    assert out.endswith("\n")
    parsed = json.loads(out)
    assert parsed == {
        "jsonrpc": "2.0",
        "method": "chat.completions.chunk",
        "params": {"request_id": "abc", "delta": {"content": "x"}},
    }
    assert "id" not in parsed


def test_format_notification_empty_params() -> None:
    out = format_notification(method="m", params={})
    parsed = json.loads(out)
    assert parsed["params"] == {}


def test_format_notification_utf8_multibyte() -> None:
    out = format_notification(
        method="chat.completions.chunk",
        params={"request_id": "r", "delta": {"content": "日本語"}},
    )
    assert "日本語" in out
    assert len(out.encode("utf-8")) < MAX_MESSAGE_BYTES


def test_format_notification_oversized_raises() -> None:
    huge = "x" * (MAX_MESSAGE_BYTES + 10)
    with pytest.raises(JsonRpcInvalidRequestError):
        format_notification(
            method="chat.completions.chunk",
            params={"request_id": "r", "delta": {"content": huge}},
        )
