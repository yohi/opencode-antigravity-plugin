import pytest
from opencode_antigravity.protocol import (
    JsonRpcError,
    JsonRpcRequest,
    JsonRpcSuccess,
    format_error,
    format_response,
    parse_request,
)


def test_parse_valid_request() -> None:
    # Test with dict params
    req1 = parse_request('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"hi"}}')
    assert isinstance(req1, JsonRpcRequest)
    assert req1.params == {"text": "hi"}

    # Test with list params (JSON-RPC 2.0 allows positional params)
    req2 = parse_request('{"jsonrpc":"2.0","id":2,"method":"add","params":[1, 2]}')
    assert isinstance(req2, JsonRpcRequest)
    assert req2.params == [1, 2]


def test_parse_invalid_jsonrpc_version() -> None:
    with pytest.raises(ValueError, match="jsonrpc version"):
        parse_request('{"jsonrpc":"1.0","id":1,"method":"echo","params":{}}')


def test_parse_non_dict_input() -> None:
    # Input like "[]" should raise ValueError, not AttributeError
    with pytest.raises(ValueError, match="invalid jsonrpc version"):
        parse_request("[]")
    with pytest.raises(ValueError, match="invalid jsonrpc version"):
        parse_request("42")


def test_format_response() -> None:
    resp = format_response(JsonRpcSuccess(id=1, result={"text": "hi"}))
    assert resp == '{"jsonrpc":"2.0","id":1,"result":{"text":"hi"}}'


def test_format_error_with_code() -> None:
    err = format_error(JsonRpcError(id=1, code=-32602, message="Invalid params"))
    assert err == '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params"}}'

