import pytest
from opencode_antigravity.handlers import (
    chat_completions,
    echo,
    health,
)


def test_echo() -> None:
    assert echo({"text": "hi"}) == {"text": "hi"}


def test_health() -> None:
    result = health({})
    assert result["status"] == "ok"
    assert "version" in result


def test_chat_completions_returns_openai_format() -> None:
    result = chat_completions(
        {
            "model": "opencode-antigravity-echo",
            "messages": [{"role": "user", "content": "hi"}],
        }
    )
    assert result["object"] == "chat.completion"
    assert result["model"] == "opencode-antigravity-echo"
    assert result["choices"][0]["message"]["role"] == "assistant"
    assert result["choices"][0]["message"]["content"] == "[echo] hi"
    assert result["choices"][0]["finish_reason"] == "stop"
    assert result["id"].startswith("chatcmpl-")
    assert result["usage"] == {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0,
    }


def test_chat_completions_uses_last_user_message() -> None:
    result = chat_completions(
        {
            "model": "opencode-antigravity-echo",
            "messages": [
                {"role": "user", "content": "first"},
                {"role": "assistant", "content": "hello"},
                {"role": "user", "content": "last"},
            ],
        }
    )
    assert result["choices"][0]["message"]["content"] == "[echo] last"


def test_chat_completions_invalid_params() -> None:
    with pytest.raises(ValueError):
        chat_completions({"model": "x"})  # messages 欠落


def test_chat_completions_missing_user_role() -> None:
    with pytest.raises(ValueError, match="no user messages"):
        chat_completions(
            {
                "model": "x",
                "messages": [
                    {"role": "system", "content": "you are a bot"},
                    {"role": "assistant", "content": "hello"},
                ],
            }
        )
