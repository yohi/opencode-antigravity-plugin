import os
import statistics
import time
from contextlib import aclosing

import pytest
from opencode_antigravity.antigravity_client import AntigravityClient

pytestmark = pytest.mark.live


@pytest.mark.asyncio
async def test_live_stream_chat_smoke() -> None:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        pytest.skip("GEMINI_API_KEY not set")
    client = AntigravityClient(
        model=os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-pro"),
        api_key=api_key,
    )
    await client.start()
    try:
        chunks: list[str] = []
        async for token in client.stream_chat([{"role": "user", "content": "Say 'pong'."}]):
            chunks.append(token)
        assert any(chunk.strip() for chunk in chunks), "expected at least one non-empty token"
    finally:
        await client.stop()


@pytest.mark.asyncio
async def test_live_cold_start_within_budget() -> None:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        pytest.skip("GEMINI_API_KEY not set")
    budget_ms = float(os.environ.get("OAG_AGENT_COLDSTART_BUDGET_MS", "5000"))
    model = os.environ.get("ANTIGRAVITY_MODEL", "gemini-2.5-pro")

    samples_ms: list[float] = []
    for _ in range(10):
        client = AntigravityClient(model=model, api_key=api_key)
        started = False
        try:
            t0 = time.perf_counter()
            await client.start()
            started = True
            async with aclosing(client.stream_chat([{"role": "user", "content": "hi"}])) as gen:
                async for _ in gen:
                    break
            samples_ms.append((time.perf_counter() - t0) * 1000.0)
        finally:
            if started:
                await client.stop()

    median_ms = statistics.median(samples_ms)
    assert median_ms < budget_ms, (
        f"TTFB median {median_ms:.1f}ms exceeds budget {budget_ms:.0f}ms; "
        f"samples={[round(sample) for sample in samples_ms]}"
    )
