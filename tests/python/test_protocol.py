import pytest
from opencode_antigravity.protocol import (
    JsonRpcError,
    JsonRpcInvalidRequestError,
    JsonRpcParseError,
    JsonRpcRequest,
    JsonRpcSuccess,
    format_error,
    format_response,
    parse_request,
)


def test_parse_valid_request() -> None:
    # ... (unchanged)
    req1 = parse_request('{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"hi"}}')
    assert isinstance(req1, JsonRpcRequest)
    assert req1.params == {"text": "hi"}

    # Test with list params (JSON-RPC 2.0 allows positional params)
    req2 = parse_request('{"jsonrpc":"2.0","id":2,"method":"add","params":[1, 2]}')
    assert isinstance(req2, JsonRpcRequest)
    assert req2.params == [1, 2]


def test_parse_notification() -> None:
    # Notification has no id
    req = parse_request('{"jsonrpc":"2.0","method":"notify","params":{}}')
    assert isinstance(req, JsonRpcRequest)
    assert req.id is None
    assert req.method == "notify"


def test_parse_request_with_null_id() -> None:
    # JSON-RPC 2.0 allows id: null
    req = parse_request('{"jsonrpc":"2.0","id":null,"method":"echo","params":{}}')
    assert isinstance(req, JsonRpcRequest)
    assert req.id is None


def test_parse_malformed_json() -> None:
    with pytest.raises(JsonRpcParseError, match="parse error"):
        parse_request("{invalid")


def test_parse_invalid_jsonrpc_version() -> None:
    with pytest.raises(JsonRpcInvalidRequestError, match="jsonrpc version"):
        parse_request('{"jsonrpc":"1.0","id":1,"method":"echo","params":{}}')


def test_parse_non_dict_input() -> None:
    with pytest.raises(JsonRpcInvalidRequestError, match="expected object"):
        parse_request("[]")
    with pytest.raises(JsonRpcInvalidRequestError, match="expected object"):
        parse_request("42")


def test_parse_missing_required_fields() -> None:
    # Missing 'method'
    with pytest.raises(JsonRpcInvalidRequestError, match="invalid request shape"):
        parse_request('{"jsonrpc":"2.0","id":1}')


def test_parse_extra_fields_forbidden() -> None:
    # extra='forbid' should reject 'unknown' field
    with pytest.raises(JsonRpcInvalidRequestError, match="Extra inputs are not permitted"):
        parse_request('{"jsonrpc":"2.0","id":1,"method":"echo","unknown":"field"}')


def test_format_response() -> None:
    resp = format_response(JsonRpcSuccess(id=1, result={"text": "hi"}))
    assert resp == '{"jsonrpc":"2.0","id":1,"result":{"text":"hi"}}'


def test_format_error_with_data() -> None:
    err = format_error(JsonRpcError(id=1, code=-32602, message="Invalid params", data={"key": "val"}))
    assert '"data":{"key":"val"}' in err
    assert '"code":-32602' in err


def test_format_error_with_code() -> None:
    err = format_error(JsonRpcError(id=1, code=-32602, message="Invalid params"))
    assert err == '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params"}}'

