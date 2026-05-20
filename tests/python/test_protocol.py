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
    req = parse_request('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"hi"}}')
    assert isinstance(req, JsonRpcRequest)
    assert req.id == 1
    assert req.method == "echo"
    assert req.params == {"text": "hi"}


def test_parse_invalid_jsonrpc_version() -> None:
    with pytest.raises(ValueError, match="jsonrpc version"):
        parse_request('{"jsonrpc":"1.0","id":1,"method":"echo","params":{}}')


def test_format_response() -> None:
    resp = format_response(JsonRpcSuccess(id=1, result={"text": "hi"}))
    assert resp == '{"jsonrpc":"2.0","id":1,"result":{"text":"hi"}}'


def test_format_error_with_code() -> None:
    err = format_error(JsonRpcError(id=1, code=-32602, message="Invalid params"))
    assert '"code":-32602' in err
    assert '"message":"Invalid params"' in err
