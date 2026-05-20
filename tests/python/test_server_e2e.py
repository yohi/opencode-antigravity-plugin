import json
import subprocess
import sys
import time


def _spawn() -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [sys.executable, "-m", "opencode_antigravity"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def _rpc(proc: subprocess.Popen[bytes], req: dict) -> dict:
    assert proc.stdin and proc.stdout
    proc.stdin.write((json.dumps(req) + "\n").encode())
    proc.stdin.flush()
    line = proc.stdout.readline().decode()
    return json.loads(line)


def test_health_round_trip() -> None:
    proc = _spawn()
    try:
        time.sleep(0.2)  # 起動猶予
        resp = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "health", "params": {}})
        assert resp["id"] == 1
        assert resp["result"]["status"] == "ok"
    finally:
        proc.terminate()
        proc.wait(timeout=3)


def test_unknown_method_returns_minus_32601() -> None:
    proc = _spawn()
    try:
        time.sleep(0.2)
        resp = _rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "nope", "params": {}})
        assert resp["error"]["code"] == -32601
    finally:
        proc.terminate()
        proc.wait(timeout=3)
