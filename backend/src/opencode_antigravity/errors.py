"""SDK exception to JSON-RPC error-code mapping for Phase 2."""

from __future__ import annotations

import asyncio
import re


class SdkError(Exception):
    code: int = -32603

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class SdkAuthError(SdkError):
    code = -32010


class SdkRateLimitError(SdkError):
    code = -32011


class SdkModelError(SdkError):
    code = -32012


class SdkApiError(SdkError):
    code = -32013


class SdkTimeoutError(SdkError):
    code = -32014


class SdkConnectionError(SdkError):
    code = -32015


def sdk_exception_to_jsonrpc_error(exc: BaseException) -> dict[str, object]:
    if isinstance(exc, SdkError):
        return {"code": exc.code, "message": exc.message}
    return {"code": -32603, "message": f"Internal error: {exc}"}


_AUTH_PATTERN = re.compile(r"api[\s_-]?key|unauthor|\b401\b", re.IGNORECASE)
_RATE_LIMIT_HTTP_STATUS = 429
_MODEL_NOT_FOUND_HTTP_STATUS = 404


def classify_sdk_error(exc: BaseException) -> SdkError:
    """Classify raw Google Antigravity / GenAI SDK exceptions into Phase 2 SDK errors."""
    if isinstance(exc, SdkError):
        return exc

    if isinstance(exc, asyncio.TimeoutError):
        return SdkTimeoutError(str(exc) or "operation timed out")

    type_name = f"{type(exc).__module__}.{type(exc).__qualname__}"

    if type_name.endswith("AntigravityConnectionError"):
        message = str(exc)
        if _AUTH_PATTERN.search(message):
            return SdkAuthError(message)
        return SdkConnectionError(message)

    if type_name.endswith("AntigravityValidationError"):
        return SdkModelError(str(exc))

    _sc = getattr(exc, "status_code", None)
    status = _sc if _sc is not None else getattr(exc, "code", None)
    if type_name.endswith("ClientError"):
        if status == _RATE_LIMIT_HTTP_STATUS:
            return SdkRateLimitError(str(exc))
        if status == _MODEL_NOT_FOUND_HTTP_STATUS:
            return SdkModelError(str(exc))
        return SdkApiError(str(exc))

    if type_name.endswith(("APIError", "ServerError")):
        return SdkApiError(str(exc))

    return SdkApiError(f"unclassified SDK error: {type_name}: {exc}")
