import pytest
from opencode_antigravity.antigravity_client import MockAntigravityClient


@pytest.mark.asyncio
async def test_lifecycle_each_request_creates_new_agent():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        chunks_1: list[str] = []
        async for chunk in client.stream_chat([{"role": "user", "content": "hello"}]):
            chunks_1.append(chunk)
        assert chunks_1 == ["[mock] ", "hello"]
        assert client.agent_enter_count == 1
        assert client.agent_exit_count == 1

        chunks_2: list[str] = []
        async for chunk in client.stream_chat([{"role": "user", "content": "world"}]):
            chunks_2.append(chunk)
        assert chunks_2 == ["[mock] ", "world"]
        assert client.agent_enter_count == 2
        assert client.agent_exit_count == 2
        assert client.last_two_agent_ids[0] != client.last_two_agent_ids[1]
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_stream_handler_exception_still_exits_agent():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        with pytest.raises(RuntimeError, match="injected"):
            async for _ in client.stream_chat(
                [{"role": "user", "content": "x"}],
                mock_options={"raise_after_chunk": 1, "raise_kind": "runtime"},
            ):
                pass
        assert client.agent_enter_count == 1
        assert client.agent_exit_count == 1
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_agent_enter_failure_does_not_exit():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    client.fail_next_enter = True
    await client.start()
    try:
        with pytest.raises(RuntimeError, match="cold-start failure"):
            async for _ in client.stream_chat([{"role": "user", "content": "x"}]):
                pass
        assert client.agent_enter_attempt_count == 1
        assert client.agent_enter_count == 0
        assert client.agent_exit_count == 0
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_chat_aggregates_stream():
    client = MockAntigravityClient(model="gemini-2.5-pro")
    await client.start()
    try:
        result = await client.chat([{"role": "user", "content": "hello"}])
        assert result == "[mock] hello"
    finally:
        await client.stop()
