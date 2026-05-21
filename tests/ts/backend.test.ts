import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PythonBackend } from "../../src/backend.js";

let backend: PythonBackend;

beforeEach(() => {
  backend = new PythonBackend({
    pythonBin: "python",
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
    // 再起動完了を待つ (最大 10秒のタイムアウト)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout waiting for backend to restart"));
      }, 10000);

      const onReady = () => {
        cleanup();
        resolve();
      };
      const onFailed = () => {
        cleanup();
        reject(new Error("Backend failed permanently"));
      };

      const cleanup = () => {
        clearTimeout(timer);
        backend.removeListener("ready", onReady);
        backend.removeListener("permanently_failed", onFailed);
      };

      backend.once("ready", onReady);
      backend.once("permanently_failed", onFailed);
    });
    expect(backend.restartCount).toBe(1);
    const res = (await backend.call("health", {})) as { status: string };
    expect(res.status).toBe("ok");
  });
});
