import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

const RUN_LIVE = Boolean(process.env.GEMINI_API_KEY);
const PORT = 11439;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProc: ChildProcess | undefined;
let serverOutput = "";

beforeAll(async () => {
  if (!RUN_LIVE) {
    return;
  }

  serverProc = spawn("node", ["dist/src/index.js"], {
    env: {
      ...process.env,
      OAG_BACKEND_MODE: "live",
      ANTIGRAVITY_MODEL: process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
      PYTHON_BIN: process.env.PYTHON_BIN ?? (existsSync(".venv/bin/python") ? ".venv/bin/python" : "python"),
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout?.on("data", (chunk: Buffer) => {
    serverOutput += chunk.toString("utf8");
  });
  serverProc.stderr?.on("data", (chunk: Buffer) => {
    serverOutput += chunk.toString("utf8");
  });

  await waitForHealthz();
}, 35_000);

afterAll(async () => {
  if (!serverProc || serverProc.killed) {
    return;
  }
  serverProc.kill();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    serverProc?.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
});

describe.skipIf(!RUN_LIVE)("SSE live", () => {
  it("streams at least one real Gemini chunk and [DONE]", async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
        messages: [{ role: "user", content: "Say hi in 5 words." }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const frames = await readSse(res);
    expect(frames.some((frame) => frame.startsWith("data: "))).toBe(true);
    expect(frames.at(-1)).toBe("data: [DONE]");
  }, 60_000);
});

async function waitForHealthz(): Promise<void> {
  if (!serverProc) {
    throw new Error("live server process was not started");
  }
  let lastError = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (serverProc.exitCode !== null) {
      throw new Error(`live server exited before ready: ${serverOutput}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) {
        return;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`live server did not become ready: ${lastError}\n${serverOutput}`);
}

async function readSse(res: Response): Promise<string[]> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("response body is not readable");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: string[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      frames.push(frame);
      if (frame === "data: [DONE]") {
        return frames;
      }
      index = buffer.indexOf("\n\n");
    }
  }
  return frames;
}
