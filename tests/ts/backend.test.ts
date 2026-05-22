import { afterEach, beforeEach, describe, expect, test } from "vitest";
import path from "node:path";
import { PythonBackend } from "../../src/backend.js";
import { BackendCrashedError, BackendPermanentlyFailedError } from "../../src/errors.js";

let backend: PythonBackend;

function getPythonBin(): string {
  return process.env.VIRTUAL_ENV
    ? path.join(process.env.VIRTUAL_ENV, process.platform === "win32" ? "Scripts" : "bin", "python")
    : "python";
}

async function waitForState(
  target: PythonBackend,
  state: "ready" | "restarting" | "permanently_failed",
  timeoutMs = 10000,
): Promise<void> {
  if (target.currentState === state) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for state: ${state}`));
    }, timeoutMs);
    const onReady = () => {
      if (state === "ready") {
        cleanup();
        resolve();
      }
    };
    const onRestarting = () => {
      if (state === "restarting") {
        cleanup();
        resolve();
      }
    };
    const onFailed = () => {
      if (state === "permanently_failed") {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeListener("ready", onReady);
      target.removeListener("restarting", onRestarting);
      target.removeListener("permanently_failed", onFailed);
    };
    target.on("ready", onReady);
    target.on("restarting", onRestarting);
    target.on("permanently_failed", onFailed);
  });
}

beforeEach(() => {
  backend = new PythonBackend({
    pythonBin: getPythonBin(),
    moduleName: "opencode_antigravity",
    cwd: process.cwd(),
    healthTimeoutMs: 5000,
    callTimeoutMs: 10000,
    maxRestarts: 3,
    backoffMs: [1000, 2000, 4000],
  });
});

afterEach(async () => {
  await backend.stop();
});

describe("PythonBackend lifecycle", () => {
  test("starts python and health succeeds (#14)", async () => {
    await backend.start();
    const res = (await backend.call("health", {})) as { status: string };
    expect(res.status).toBe("ok");
  });

  test("echo round-trips correctly (#15)", async () => {
    await backend.start();
    const res = (await backend.call("echo", { text: "ping" })) as { text: string };
    expect(res.text).toBe("ping");
  });

  test("detects crash and restarts (#16)", async () => {
    await backend.start();
    const pid = backend.pid;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGKILL");
    // 再起動プロセスが開始されるのを待つ
    await waitForState(backend, "restarting", 5000);
    // 再起動完了を待つ
    await waitForState(backend, "ready", 10000);
    expect(backend.restartCount).toBe(1);
    const res = (await backend.call("health", {})) as { status: string };
    expect(res.status).toBe("ok");
  });
});

describe("PythonBackend failure semantics", () => {
  test("after 3 failed restarts marks permanently_failed (#17)", async () => {
    // 起動の度に即終了するスタブを使う: 存在しないモジュール名で連続失敗を再現
    const bad = new PythonBackend({
      pythonBin: getPythonBin(),
      moduleName: "this_module_does_not_exist_xyz",
      cwd: process.cwd(),
      healthTimeoutMs: 500,
      callTimeoutMs: 1000,
      maxRestarts: 3,
      backoffMs: [50, 50, 50], // テスト高速化
    });
    try {
      await expect(bad.start()).rejects.toBeInstanceOf(BackendCrashedError);
      // 3 回再起動失敗まで待つ
      await waitForState(bad, "permanently_failed", 5000);
      expect(bad.currentState).toBe("permanently_failed");
      await expect(bad.call("health", {})).rejects.toBeInstanceOf(BackendPermanentlyFailedError);
    } finally {
      await bad.stop();
    }
  });

  test("request arriving during restart wait returns 503 immediately without queueing (#18)", async () => {
    const backoffMs = [1500, 1500, 1500];
    const back = new PythonBackend({
      pythonBin: getPythonBin(),
      moduleName: "opencode_antigravity",
      cwd: process.cwd(),
      healthTimeoutMs: 5000,
      callTimeoutMs: 5000,
      maxRestarts: 3,
      backoffMs,
    });
    try {
      await back.start();
      const pid = back.pid;
      process.kill(pid, "SIGKILL");
      // restarting 状態に遷移するのを待つ
      await waitForState(back, "restarting", 5000);
      const t0 = Date.now();
      await expect(back.call("echo", { text: "x" })).rejects.toBeInstanceOf(BackendCrashedError);
      const elapsed = Date.now() - t0;
      expect(backoffMs[0]).toBeDefined();
      expect(elapsed).toBeLessThan(backoffMs[0]! / 2); // キューイングしていないことをバックオフ時間との相対値で検証
      // restart 完了後の通常応答も確認
      await waitForState(back, "ready", 10000);
      const res = (await back.call("echo", { text: "after" })) as { text: string };
      expect(res.text).toBe("after");
    } finally {
      await back.stop();
    }
  }, 15000);
});
