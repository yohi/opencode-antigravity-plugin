import asyncio

from opencode_antigravity.errors import (
    SdkApiError,
    SdkAuthError,
    SdkConnectionError,
    SdkModelError,
    SdkRateLimitError,
    SdkTimeoutError,
    classify_sdk_error,
    sdk_exception_to_jsonrpc_error,
)


def test_sdk_auth_error_code() -> None:
    err = SdkAuthError("auth failed")
    assert err.code == -32010
    assert err.message == "auth failed"


def test_sdk_rate_limit_error_code() -> None:
    assert SdkRateLimitError("x").code == -32011


def test_sdk_model_error_code() -> None:
    assert SdkModelError("x").code == -32012


def test_sdk_api_error_code() -> None:
    assert SdkApiError("x").code == -32013


def test_sdk_timeout_error_code() -> None:
    assert SdkTimeoutError("x").code == -32014


def test_sdk_connection_error_code() -> None:
    assert SdkConnectionError("x").code == -32015


def test_to_jsonrpc_error_serializes_dict_shape() -> None:
    err = SdkAuthError("invalid api key")
    jr = sdk_exception_to_jsonrpc_error(err)
    assert jr == {"code": -32010, "message": "invalid api key"}


def test_unknown_exception_maps_to_internal_error() -> None:
    jr = sdk_exception_to_jsonrpc_error(RuntimeError("boom"))
    assert jr["code"] == -32603
    assert "boom" in jr["message"]


def test_classify_asyncio_timeout_maps_to_timeout() -> None:
    assert isinstance(classify_sdk_error(asyncio.TimeoutError("late")), SdkTimeoutError)


def test_classify_already_sdk_error_passes_through() -> None:
    err = SdkAuthError("auth")
    assert classify_sdk_error(err) is err


class _FakeAntigravityConnectionError(Exception):
    pass


_FakeAntigravityConnectionError.__module__ = "google.antigravity.types"
_FakeAntigravityConnectionError.__qualname__ = "AntigravityConnectionError"


def test_classify_antigravity_connection_with_auth_pattern_maps_to_auth() -> None:
    exc = _FakeAntigravityConnectionError("request failed (code 400): API key not valid")
    assert isinstance(classify_sdk_error(exc), SdkAuthError)


def test_classify_antigravity_connection_without_auth_maps_to_connection() -> None:
    exc = _FakeAntigravityConnectionError("transport reset")
    assert isinstance(classify_sdk_error(exc), SdkConnectionError)


class _FakeClientError(Exception):
    def __init__(self, msg: str, status_code: int) -> None:
        super().__init__(msg)
        self.status_code = status_code


_FakeClientError.__module__ = "google.genai.errors"
_FakeClientError.__qualname__ = "ClientError"


def test_classify_client_error_429_maps_to_rate_limit() -> None:
    assert isinstance(classify_sdk_error(_FakeClientError("too many", 429)), SdkRateLimitError)


def test_classify_client_error_404_maps_to_model_not_found() -> None:
    assert isinstance(classify_sdk_error(_FakeClientError("no model", 404)), SdkModelError)


def test_classify_client_error_500_maps_to_api_error() -> None:
    assert isinstance(classify_sdk_error(_FakeClientError("server down", 500)), SdkApiError)


def test_classify_unknown_exception_fallbacks_to_api_error() -> None:
    fallback = classify_sdk_error(RuntimeError("mystery"))
    assert isinstance(fallback, SdkApiError)
    assert "RuntimeError" in fallback.message
