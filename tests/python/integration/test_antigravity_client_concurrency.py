import asyncio
import time
from collections.abc import AsyncGenerator, Sequence

import pytest
from opencode_antigravity.antigravity_client import MockAntigravityClient, MockOptions
from opencode_antigravity.prompt_folding import ChatMessage


class _SlowMockClient(MockAntigravityClient):
    def __init__(self, model: str, enter_sleep_s: float = 0.2) -> None:
        super().__init__(model)
        self.enter_sleep_s = enter_sleep_s
        self.active_enter_count: int = 0
        self.peak_active_enter: int = 0

    async def stream_chat(
        self, messages: Sequence[ChatMessage], *, mock_options: MockOptions | None = None
    ) -> AsyncGenerator[str, None]:
        from opencode_antigravity.antigravity_client import _get_semaphore

        _ = mock_options
        async with _get_semaphore():
            self.active_enter_count += 1
            self.peak_active_enter = max(self.peak_active_enter, self.active_enter_count)
            try:
                await asyncio.sleep(self.enter_sleep_s)
                last_user = ""
                for message in reversed(messages):
                    if message.get("role") == "user":
                        content_value = message.get("content", "")
                        last_user = content_value if isinstance(content_value, str) else ""
                        break
                yield "[mock] "
                yield last_user
            finally:
                self.active_enter_count -= 1


@pytest.mark.asyncio
async def test_per_request_agent_lifecycle_isolation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OAG_MAX_CONCURRENT_REQUESTS", "1")
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        async for _ in client.stream_chat([{"role": "user", "content": "first"}]):
            pass
        async for _ in client.stream_chat([{"role": "user", "content": "second"}]):
            pass
        assert client.agent_enter_count == 2
        assert client.agent_exit_count == 2
        assert client.last_two_agent_ids[0] != client.last_two_agent_ids[1]
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_concurrent_requests_respect_semaphore(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OAG_MAX_CONCURRENT_REQUESTS", "2")
    client = _SlowMockClient(model="gemini-2.5-pro", enter_sleep_s=0.2)
    await client.start()

    async def run_one(text: str) -> list[str]:
        chunks: list[str] = []
        async for token in client.stream_chat([{"role": "user", "content": text}]):
            chunks.append(token)
        return chunks

    t0 = time.perf_counter()
    try:
        results = await asyncio.gather(*(run_one(f"msg{i}") for i in range(4)))
    finally:
        await client.stop()
    elapsed = time.perf_counter() - t0

    assert results == [["[mock] ", f"msg{i}"] for i in range(4)]
    assert client.peak_active_enter <= 2, f"semaphore breached: peak={client.peak_active_enter}"
    assert elapsed >= 0.4 - 0.05


@pytest.mark.asyncio
async def test_cold_start_timeout_maps_to_sdk_connection_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from opencode_antigravity.antigravity_client import _coldstart_timeout_s
    from opencode_antigravity.errors import SdkConnectionError

    monkeypatch.setenv("OAG_AGENT_COLDSTART_TIMEOUT_MS", "50")

    class _NeverEnterClient(MockAntigravityClient):
        async def stream_chat(
            self, messages: Sequence[ChatMessage], *, mock_options: MockOptions | None = None
        ) -> AsyncGenerator[str, None]:
            _ = messages
            _ = mock_options
            try:
                await asyncio.wait_for(asyncio.sleep(1.0), timeout=_coldstart_timeout_s())
            except asyncio.TimeoutError as exc:
                raise SdkConnectionError(
                    "Agent cold-start exceeded OAG_AGENT_COLDSTART_TIMEOUT_MS"
                ) from exc
            yield "unreachable"

    client = _NeverEnterClient(model="gemini-2.5-pro")
    await client.start()
    try:
        with pytest.raises(SdkConnectionError):
            async for _ in client.stream_chat([{"role": "user", "content": "x"}]):
                pass
    finally:
        await client.stop()
