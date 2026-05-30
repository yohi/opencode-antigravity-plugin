"""stdio JSON-RPC dispatch loop.

設計書 Section 5.1.1 (sentinel `_final` 方式) に準拠した AsyncGenerator dispatch を含む。
ハンドラ戻り値が:
  * AsyncGenerator + ``params.stream is True`` → 通常 yield を Notification として送出し、
    最終 yield の ``{"_final": {...}}`` を最終 Response の ``result`` に載せる。
  * AsyncGenerator + ``params.stream`` が False/欠落 → 契約違反 (handlers 側で集約済 dict を
    返すべき) として ``-32603 Internal error`` を返す。``agen.aclose()`` を必ず呼ぶ。
  * dict / Awaitable[dict] → Phase 1 互換で 1 発の Response。
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
import sys
from collections.abc import Callable
from typing import Any, Protocol

from .errors import SdkError, sdk_exception_to_jsonrpc_error
from .handlers import chat_completions, echo, health
from .protocol import (
    JsonRpcError,
    JsonRpcInvalidRequestError,
    JsonRpcParseError,
    JsonRpcSuccess,
    format_error,
    format_notification,
    format_response,
    parse_request,
)

logger = logging.getLogger(__name__)

# Handler may return: dict | Awaitable[dict] | AsyncGenerator[dict, None]
Handler = Callable[[dict[str, Any]], Any]


class _Writer(Protocol):
    """Minimal interface for stdout-side writers (asyncio.StreamWriter compatible)."""

    def write(self, data: bytes) -> None: ...

    async def drain(self) -> None: ...

    def close(self) -> None: ...


def _default_handlers() -> dict[str, Handler]:
    handlers: dict[str, Handler] = {
        "health": health,
        "echo": echo,
        "chat.completions": chat_completions,
    }

    if os.environ.get("OPENCODE_ANTIGRAVITY_ENABLE_TEST_HANDLERS", "").lower() == "true":
        def _crash_handler(_params: dict[str, Any]) -> dict[str, Any]:
            raise RuntimeError("simulated crash")

        handlers["__crash__"] = _crash_handler

    return handlers


async def run(
    reader: asyncio.StreamReader,
    writer: _Writer,
    handlers: dict[str, Handler] | None = None,
) -> None:
    """Read NDJSON requests from ``reader``, dispatch via ``handlers``, write
    Responses (and Notifications for AsyncGenerator handlers) to ``writer``.
    """
    table = handlers if handlers is not None else _default_handlers()
    while True:
        try:
            raw = await reader.readline()
        except Exception:  # noqa: BLE001
            logger.exception("read error from input stream")
            break
        if not raw:
            break  # EOF

        try:
            line = raw.decode("utf-8").rstrip("\n").rstrip("\r")
        except UnicodeDecodeError:
            logger.warning("invalid utf-8 sequence in input")
            err = format_error(
                JsonRpcError(id=None, code=-32700, message="Parse error: invalid utf-8")
            )
            writer.write(err.encode("utf-8"))
            await writer.drain()
            continue

        if not line:
            continue

        await _process_one(line, table, writer)


async def _process_one(line: str, table: dict[str, Handler], writer: _Writer) -> None:
    # ---- Parse ----
    try:
        req = parse_request(line)
    except JsonRpcParseError as e:
        logger.warning("parse error: %s", e)
        writer.write(
            format_error(
                JsonRpcError(id=None, code=-32700, message=f"Parse error: {e}")
            ).encode("utf-8")
        )
        await writer.drain()
        return
    except JsonRpcInvalidRequestError as e:
        logger.warning("invalid request: %s", e)
        writer.write(
            format_error(
                JsonRpcError(id=None, code=-32600, message=f"Invalid Request: {e}")
            ).encode("utf-8")
        )
        await writer.drain()
        return
    except Exception:  # noqa: BLE001
        logger.exception("unexpected error during parse")
        writer.write(
            format_error(JsonRpcError(id=None, code=-32700, message="Parse error")).encode(
                "utf-8"
            )
        )
        await writer.drain()
        return

    # ---- Notification path (no id) ----
    if req.id is None:
        handler = table.get(req.method)
        if handler is not None:
            try:
                result = handler(req.params)
                if inspect.isasyncgen(result):
                    try:
                        async for _item in result:
                            pass
                    finally:
                        await result.aclose()
                elif inspect.isawaitable(result):
                    await result
            except Exception:  # noqa: BLE001
                logger.exception("notification handler crashed: %s", req.method)
        return

    # ---- Method lookup ----
    handler = table.get(req.method)
    if handler is None:
        writer.write(
            format_error(
                JsonRpcError(id=req.id, code=-32601, message=f"Method not found: {req.method}")
            ).encode("utf-8")
        )
        await writer.drain()
        return

    # ---- Handler invocation (sync exceptions in handler creation only) ----
    try:
        result = handler(req.params)
    except ValueError as e:
        writer.write(
            format_error(
                JsonRpcError(id=req.id, code=-32602, message=f"Invalid params: {e}")
            ).encode("utf-8")
        )
        await writer.drain()
        return
    except Exception:  # noqa: BLE001
        logger.exception("handler crashed: %s", req.method)
        writer.write(
            format_error(
                JsonRpcError(id=req.id, code=-32603, message="Internal error")
            ).encode("utf-8")
        )
        await writer.drain()
        return

    # ---- Dispatch on result type ----
    params_dict: dict[str, Any] = req.params if isinstance(req.params, dict) else {}

    if inspect.isasyncgen(result) and params_dict.get("stream") is True:
        await _dispatch_async_stream(result, req.id, req.method, writer)
        return

    if inspect.isasyncgen(result):
        # 設計書 5.2: stream:false で AsyncGenerator は契約違反 (handlers 側で集約済 dict を
        # 返すべき)。Notification は送信せず -32603 Internal error を返す。
        await result.aclose()
        logger.error(
            "AsyncGenerator handler returned with stream != True (contract violation): %s",
            req.method,
        )
        writer.write(
            format_error(
                JsonRpcError(id=req.id, code=-32603, message="Internal error")
            ).encode("utf-8")
        )
        await writer.drain()
        return

    # sync dict / awaitable dict
    try:
        response = await result if inspect.isawaitable(result) else result
    except ValueError as e:
        writer.write(
            format_error(
                JsonRpcError(id=req.id, code=-32602, message=f"Invalid params: {e}")
            ).encode("utf-8")
        )
        await writer.drain()
        return
    except SdkError as e:
        sdk_err = sdk_exception_to_jsonrpc_error(e)
        writer.write(
            format_error(
                JsonRpcError(
                    id=req.id,
                    code=int(sdk_err["code"]),
                    message=str(sdk_err["message"]),
                )
            ).encode("utf-8")
        )
        await writer.drain()
        return
    except Exception:  # noqa: BLE001
        logger.exception("handler crashed (await): %s", req.method)
        writer.write(
            format_error(
                JsonRpcError(id=req.id, code=-32603, message="Internal error")
            ).encode("utf-8")
        )
        await writer.drain()
        return

    writer.write(format_response(JsonRpcSuccess(id=req.id, result=response)).encode("utf-8"))
    await writer.drain()


async def _dispatch_async_stream(
    agen: Any,
    req_id: int | str,
    method: str,
    writer: _Writer,
) -> None:
    """AsyncGenerator + stream:true: 通常 yield → Notification, sentinel ``_final`` → Response.

    設計書 Section 5.1.1 に準拠。例外時/早期 break 時も ``agen.aclose()`` を finally で
    確実に呼ぶ。``_final`` を一度も yield しない場合は ``final_meta = {}`` で最終 Response
    を返す (TS 側包装が ``finish_reason`` 等を補完する)。
    """
    final_meta: dict[str, Any] = {}
    try:
        async for item in agen:
            if isinstance(item, dict) and "_final" in item:
                final_meta = item["_final"]
                break  # sentinel 以降は契約上 yield されない
            # 通常 chunk → Notification
            delta = item.get("delta", item) if isinstance(item, dict) else item
            try:
                line = format_notification(
                    f"{method}.chunk",
                    {"request_id": req_id, "delta": delta},
                )
            except ValueError:
                # 内部制約違反 (1MB超)。クライアント起因の引数エラーではないため
                # Internal error (-32603) として扱い、詳細（制限値等）は露出させない。
                writer.write(
                    format_error(
                        JsonRpcError(id=req_id, code=-32603, message="Internal error")
                    ).encode("utf-8")
                )
                await writer.drain()
                return

            writer.write(line.encode("utf-8"))
            await writer.drain()
    except ValueError as e:
        writer.write(
            format_error(
                JsonRpcError(id=req_id, code=-32602, message=f"Invalid params: {e}")
            ).encode("utf-8")
        )
        await writer.drain()
        return
    except SdkError as e:
        sdk_err = sdk_exception_to_jsonrpc_error(e)
        writer.write(
            format_error(
                JsonRpcError(
                    id=req_id,
                    code=int(sdk_err["code"]),
                    message=str(sdk_err["message"]),
                )
            ).encode("utf-8")
        )
        await writer.drain()
        return
    except Exception:  # noqa: BLE001
        logger.exception("streaming handler crashed: %s", method)
        writer.write(
            format_error(
                JsonRpcError(id=req_id, code=-32603, message="Internal error")
            ).encode("utf-8")
        )
        await writer.drain()
        return
    finally:
        # 早期 break / 例外時の確実なクリーンアップ
        await agen.aclose()

    writer.write(format_response(JsonRpcSuccess(id=req_id, result=final_meta)).encode("utf-8"))
    await writer.drain()


class _StdoutWriter:
    """sync stdout writer (write + flush) を asyncio.StreamWriter 互換の形で提供する。

    サブプロセスの ``stdout=PIPE`` 経由で NDJSON を 1 行ずつ読ませるため、
    write のたびに明示的に ``flush()`` して OS パイプへ即時に転送する。
    asyncio の ``connect_write_pipe`` 経由だとバッファリングの型ケースによって
    drain() を必要とするため、本クラスでは sync stdout を直接使う。
    1 MB 上限は ``format_*`` 関数で守られているため backpressure 不要。
    """

    def __init__(self, stream: Any | None = None) -> None:
        # Default to sys.stdout.buffer (binary) so we can write bytes directly.
        self._stream = stream if stream is not None else sys.stdout.buffer

    def write(self, data: bytes) -> None:
        self._stream.write(data)
        self._stream.flush()

    async def drain(self) -> None:  # noqa: D401 - asyncio.StreamWriter compat
        return None

    def close(self) -> None:
        try:
            self._stream.flush()
        except Exception:  # noqa: BLE001
            pass


async def async_main() -> None:
    """asyncio entry point: stdin/stdout を非同期化して ``run()`` を起動する。"""
    logging.basicConfig(
        stream=sys.stderr,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    loop = asyncio.get_running_loop()

    # stdin → StreamReader
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    # stdout は sync ラッパーを使う (subprocess.PIPE 経由での即時 flush を保証)。
    writer = _StdoutWriter()

    try:
        await run(reader=reader, writer=writer)
    finally:
        writer.close()


def main() -> None:
    """sync entry point used by ``__main__.py``. ``asyncio.run`` で ``async_main`` を起動する。"""
    asyncio.run(async_main())
