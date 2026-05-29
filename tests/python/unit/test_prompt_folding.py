import pytest
from opencode_antigravity.prompt_folding import fold_messages_to_prompt


def test_fold_chatml_format_full_conversation():
    msgs = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "What is 2+2?"},
        {"role": "assistant", "content": "4"},
        {"role": "user", "content": "Now add 3."},
    ]
    assert fold_messages_to_prompt(msgs) == (
        "<|system|>\nYou are helpful.\n"
        "<|user|>\nWhat is 2+2?\n"
        "<|assistant|>\n4\n"
        "<|user|>\nNow add 3.\n"
        "<|assistant|>\n"
    )


def test_fold_single_user_only():
    out = fold_messages_to_prompt([{"role": "user", "content": "hi"}])
    assert out == "<|user|>\nhi\n<|assistant|>\n"


def test_fold_multiple_system_messages_kept_in_order():
    msgs = [
        {"role": "system", "content": "S1"},
        {"role": "system", "content": "S2"},
        {"role": "user", "content": "U"},
    ]
    assert fold_messages_to_prompt(msgs) == (
        "<|system|>\nS1\n"
        "<|system|>\nS2\n"
        "<|user|>\nU\n"
        "<|assistant|>\n"
    )


def test_fold_empty_content_preserves_role_tag():
    msgs = [
        {"role": "system", "content": ""},
        {"role": "user", "content": "hi"},
    ]
    assert fold_messages_to_prompt(msgs).startswith("<|system|>\n\n<|user|>\n")


@pytest.mark.parametrize("bad_role", ["tool", "function", "developer", ""])
def test_fold_unknown_role_raises(bad_role: str):
    with pytest.raises(ValueError, match="unsupported role"):
        fold_messages_to_prompt([{"role": bad_role, "content": "x"}])


def test_fold_empty_messages_raises():
    with pytest.raises(ValueError, match="messages list must not be empty"):
        fold_messages_to_prompt([])

