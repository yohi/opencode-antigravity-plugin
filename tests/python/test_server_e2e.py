import json
import os
import select
import subprocess
import sys


def _spawn(extra_env: dict[str, str] | None = None) -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    # Ensure a deterministic default for testing, then allow overrides
    env["OPENCODE_ANTIGRAVITY_ENABLE_TEST_HANDLERS"] = "true"
    if extra_env:
        env.update(extra_env)

    return subprocess.Popen(
        [sys.executable, "-m", "opencode_antigravity"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )


def _rpc(proc: subprocess.Popen[bytes], req: dict, timeout: float = 5.0) -> dict:
    assert proc.stdin and proc.stdout
    proc.stdin.write((json.dumps(req) + "\n").encode())
    proc.stdin.flush()

    # Wait for data with timeout
    rlist, _, _ = select.select([proc.stdout], [], [], timeout)
    if not rlist:
        raise TimeoutError(f"RPC response timed out after {timeout}s")

    line = proc.stdout.readline().decode()
    if not line:
        raise EOFError("Server closed connection unexpectedly")
    return json.loads(line)


def _cleanup(proc: subprocess.Popen[bytes]) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def test_health_round_trip() -> None:
    proc = _spawn()
    try:
        resp = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "health", "params": {}})
        assert resp["id"] == 1
        assert resp["result"]["status"] == "ok"
    finally:
        _cleanup(proc)


def test_unknown_method_returns_minus_32601() -> None:
    proc = _spawn()
    try:
        resp = _rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "nope", "params": {}})
        assert resp["error"]["code"] == -32601
    finally:
        _cleanup(proc)


def test_invalid_utf8() -> None:
    proc = _spawn()
    try:
        _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "health", "params": {}})
        # Invalid UTF-8 sequence
        assert proc.stdin and proc.stdout
        proc.stdin.write(b"\xff\xfe\xfd\n")
        proc.stdin.flush()

        rlist, _, _ = select.select([proc.stdout], [], [], 2.0)
        assert rlist
        line = proc.stdout.readline().decode()
        resp = json.loads(line)
        assert resp["error"]["code"] == -32700
        assert "utf-8" in resp["error"]["message"].lower()
    finally:
        _cleanup(proc)


def test_notification_no_response() -> None:
    proc = _spawn()
    try:
        # Notification (no id)
        assert proc.stdin and proc.stdout
        payload = json.dumps({"jsonrpc": "2.0", "method": "health", "params": {}})
        proc.stdin.write(payload.encode() + b"\n")
        proc.stdin.flush()

        rlist, _, _ = select.select([proc.stdout], [], [], 1.0)
        assert not rlist  # No response expected within 1s
    finally:
        _cleanup(proc)


def test_invalid_request_code() -> None:
    proc = _spawn()
    try:
        # Invalid request (missing jsonrpc version)
        resp = _rpc(proc, {"id": 1, "method": "health"})
        assert resp["error"]["code"] == -32600
        assert "Invalid Request" in resp["error"]["message"]
    finally:
        _cleanup(proc)


def test_internal_error_masking() -> None:
    proc = _spawn()
    try:
        # Use the hidden __crash__ method to trigger an internal Exception (-32603).
        resp = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "__crash__", "params": {}})
        
        # Unconditionally assert that the internal error is caught and masked.
        assert "error" in resp
        assert resp["error"]["code"] == -32603
        assert resp["error"]["message"] == "Internal error"
        assert resp["id"] == 1
    finally:
        _cleanup(proc)


def test_crash_handler_disabled_by_default() -> None:
    # Explicitly disable test handlers
    proc = _spawn(extra_env={"OPENCODE_ANTIGRAVITY_ENABLE_TEST_HANDLERS": "false"})
    try:
        resp = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "__crash__", "params": {}})
        # Method should not be found
        assert resp["error"]["code"] == -32601
        assert "Method not found" in resp["error"]["message"]
    finally:
        _cleanup(proc)
