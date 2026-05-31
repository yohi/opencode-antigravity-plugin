import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { PythonBackend } from "../../src/backend.js";

interface StreamingFinal {
  finish_reason: string;
  usage: object;
}

let backend: PythonBackend | null = null;
const originalEnv = { ...process.env };

function getPythonBin(): string {
  return process.env.VIRTUAL_ENV
    ? path.join(process.env.VIRTUAL_ENV, process.platform === "win32" ? "Scripts" : "bin", "python")
    : "python";
}

function createBackend(): PythonBackend {
  return new PythonBackend({
    pythonBin: getPythonBin(),
    moduleName: "opencode_antigravity",
    cwd: process.cwd(),
    healthTimeoutMs: 5000,
    callTimeoutMs: 10000,
    maxRestarts: 3,
    backoffMs: [1000, 2000, 4000],
  });
}

afterEach(async () => {
  if (backend) {
    await backend.stop();
    backend = null;
  }
  process.env = { ...originalEnv };
});

describe("PythonBackend.streamingCall", () => {
  it("round-trips chunks and final response (#28)", async () => {
    process.env.OAG_BACKEND_MODE = "mock";
    process.env.ANTIGRAVITY_MODEL = "gemini-2.5-pro";
    backend = createBackend();
    await backend.start();

    const chunks: unknown[] = [];
    const final = await backend.streamingCall<StreamingFinal>(
      "chat.completions",
      {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      (delta) => chunks.push(delta),
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(final.finish_reason).toBe("stop");
  }, 30000);

  it("fires idle timeout when chunks stop arriving (#29)", async () => {
    process.env.OAG_BACKEND_MODE = "mock";
    process.env.ANTIGRAVITY_MODEL = "gemini-2.5-pro";
    process.env.OAG_MOCK_INITIAL_DELAY_MS = "500";
    process.env.OAG_STREAM_IDLE_TIMEOUT_MS = "100";
    backend = createBackend();
    await backend.start();

    await expect(
      backend.streamingCall(
        "chat.completions",
        {
          model: "gemini-2.5-pro",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        () => {},
      ),
    ).rejects.toThrow(/stream idle exceeded 100ms/);
  }, 30000);
});
