from __future__ import annotations

from collections.abc import Mapping, Sequence

ROLE_TAGS: dict[str, str] = {
    "system": "<|system|>",
    "user": "<|user|>",
    "assistant": "<|assistant|>",
}
PROMPT_TAIL = "<|assistant|>\n"
ChatMessage = Mapping[str, object]


def fold_messages_to_prompt(messages: Sequence[ChatMessage]) -> str:
    if not messages:
        raise ValueError("messages list must not be empty")
    parts: list[str] = []
    for msg in messages:
        role_value = msg.get("role", "")
        role = role_value if isinstance(role_value, str) else ""
        if role not in ROLE_TAGS:
            raise ValueError(f"unsupported role: {role!r}")
        content_value = msg.get("content", "")
        content = content_value if isinstance(content_value, str) else ""
        parts.append(f"{ROLE_TAGS[role]}\n{content}\n")
    parts.append(PROMPT_TAIL)
    return "".join(parts)
