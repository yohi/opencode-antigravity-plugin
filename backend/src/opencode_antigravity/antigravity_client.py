from __future__ import annotations

import asyncio
import importlib
import os
from collections.abc import AsyncGenerator, AsyncIterable, Mapping, Sequence
from types import TracebackType
from typing import Protocol, cast

from .errors import SdkApiError, SdkConnectionError, classify_sdk_error
from .prompt_folding import ChatMessage, fold_messages_to_prompt

MockOptions = Mapping[str, object]


class _StartedAgent(Protocol):
    async def chat(self, prompt: str) -> AsyncIterable[str]: ...


class _AgentContextManager(Protocol):
    async def __aenter__(self) -> _StartedAgent: ...

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> object: ...


class _AgentFactory(Protocol):
    def __call__(self, config: object) -> _AgentContextManager: ...


class _LocalAgentConfigFactory(Protocol):
    def __call__(self, *, model: str, api_key: str) -> object: ...


class AntigravityClientBase(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    def stream_chat(
        self, messages: Sequence[ChatMessage], *, mock_options: MockOptions | None = None
    ) -> AsyncGenerator[str, None]: ...

    async def chat(self, messages: Sequence[ChatMessage]) -> str: ...


def _coldstart_timeout_s() -> float:
    raw_val = os.environ.get("OAG_AGENT_COLDSTART_TIMEOUT_MS", "10000")
    try:
        val_ms = float(raw_val)
    except ValueError as exc:
        raise ValueError(
            f"OAG_AGENT_COLDSTART_TIMEOUT_MS must be a numeric millisecond value, got {raw_val!r}"
        ) from exc
    if val_ms < 0:
        raise ValueError(
            f"OAG_AGENT_COLDSTART_TIMEOUT_MS must be non-negative, got {val_ms}"
        )
    return val_ms / 1000.0


_semaphore_cache: dict[int, tuple[int, asyncio.Semaphore]] = {}


def _get_semaphore() -> asyncio.Semaphore:
    global _semaphore_cache
    loop_id = id(asyncio.get_running_loop())

    raw_val = os.environ.get("OAG_MAX_CONCURRENT_REQUESTS", "4")
    try:
        limit = int(raw_val)
    except ValueError as exc:
        raise ValueError(
            f"OAG_MAX_CONCURRENT_REQUESTS must be an integer, got {raw_val!r}"
        ) from exc
    if limit <= 0:
        raise ValueError(
            f"OAG_MAX_CONCURRENT_REQUESTS must be positive, got {limit}"
        )

    if loop_id not in _semaphore_cache or _semaphore_cache[loop_id][0] != limit:
        _semaphore_cache[loop_id] = (limit, asyncio.Semaphore(limit))
    return _semaphore_cache[loop_id][1]


class MockAntigravityClient:
    def __init__(self, model: str) -> None:
        self.model: str = model
        self.agent_enter_count: int = 0
        self.agent_enter_attempt_count: int = 0
        self.agent_exit_count: int = 0
        self.fail_next_enter: bool = False
        self.last_two_agent_ids: list[int] = []
        self._agent_id_counter: int = 0

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def stream_chat(
        self, messages: Sequence[ChatMessage], *, mock_options: MockOptions | None = None
    ) -> AsyncGenerator[str, None]:
        # Validate/normalize just like live mode
        _ = fold_messages_to_prompt(messages)

        async with _get_semaphore():
            self.agent_enter_attempt_count += 1
            if self.fail_next_enter:
                self.fail_next_enter = False
                raise RuntimeError("cold-start failure")

            initial_delay_ms = int(os.environ.get("OAG_MOCK_INITIAL_DELAY_MS", "0"))
            if initial_delay_ms > 0:
                await asyncio.sleep(initial_delay_ms / 1000.0)

            self.agent_enter_count += 1
            self._agent_id_counter += 1
            agent_id = self._agent_id_counter
            self.last_two_agent_ids.append(agent_id)
            self.last_two_agent_ids = self.last_two_agent_ids[-2:]

            try:
                last_user = ""
                for message in reversed(messages):
                    if message.get("role") == "user":
                        content_value = message.get("content", "")
                        last_user = content_value if isinstance(content_value, str) else ""
                        break
                tokens = ["[mock] ", last_user]
                yielded = 0
                raise_after_value = (mock_options or {}).get("raise_after_chunk")
                raise_after = raise_after_value if isinstance(raise_after_value, int) else None
                raise_kind_value = (mock_options or {}).get("raise_kind", "runtime")
                raise_kind = raise_kind_value if isinstance(raise_kind_value, str) else "runtime"

                for token in tokens:
                    if raise_after is not None and yielded >= raise_after:
                        if raise_kind == "sdk_api":
                            raise SdkApiError("mock injected SdkApiError")
                        raise RuntimeError("injected by mock_options")
                    yield token
                    yielded += 1
            finally:
                self.agent_exit_count += 1

    async def chat(self, messages: Sequence[ChatMessage]) -> str:
        chunks: list[str] = []
        async for token in self.stream_chat(messages):
            chunks.append(token)
        return "".join(chunks)


class AntigravityClient:
    def __init__(self, model: str, api_key: str) -> None:
        self.model: str = model
        self._api_key: str = api_key

    async def start(self) -> None:
        try:
            google_antigravity = importlib.import_module("google.antigravity")
        except ImportError as exc:
            message = (
                "google-antigravity SDK is not installed. Install with: "
                + "uv pip install 'opencode-antigravity[live]'"
            )
            raise RuntimeError(message) from exc
        _ = google_antigravity

    async def stop(self) -> None:
        return None

    async def stream_chat(
        self, messages: Sequence[ChatMessage], *, mock_options: MockOptions | None = None
    ) -> AsyncGenerator[str, None]:
        async with _get_semaphore():
            _ = mock_options
            prompt = fold_messages_to_prompt(messages)

            google_antigravity = importlib.import_module("google.antigravity")
            agent_type = cast(_AgentFactory, google_antigravity.Agent)
            config_type = cast(_LocalAgentConfigFactory, google_antigravity.LocalAgentConfig)

            agent_cm = agent_type(config_type(model=self.model, api_key=self._api_key))

            try:
                agent = await asyncio.wait_for(
                    agent_cm.__aenter__(), timeout=_coldstart_timeout_s()
                )
            except asyncio.TimeoutError as exc:
                raise SdkConnectionError(
                    "Agent cold-start exceeded OAG_AGENT_COLDSTART_TIMEOUT_MS"
                ) from exc
            except Exception as exc:
                raise classify_sdk_error(exc) from exc

            exc_info: tuple[
                type[BaseException] | None, BaseException | None, TracebackType | None
            ] = (None, None, None)
            try:
                response = await agent.chat(prompt)
                async for token in response:
                    if token:
                        yield token
            except Exception as exc:
                exc_info = (type(exc), exc, exc.__traceback__)
                raise classify_sdk_error(exc) from exc
            finally:
                _ = await agent_cm.__aexit__(*exc_info)

    async def chat(self, messages: Sequence[ChatMessage]) -> str:
        chunks: list[str] = []
        async for token in self.stream_chat(messages):
            chunks.append(token)
        return "".join(chunks)


def create_client(model: str, mode: str, api_key: str | None) -> AntigravityClientBase:
    if mode == "mock":
        return MockAntigravityClient(model=model)
    if mode == "live":
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is required for live mode")
        return AntigravityClient(model=model, api_key=api_key)
    raise ValueError(f"unknown OAG_BACKEND_MODE: {mode}")
