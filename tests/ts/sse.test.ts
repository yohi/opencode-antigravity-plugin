import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

let serverProc: ChildProcess;
let serverOutput = "";
const PORT = 11438;
const BASE_URL = `http://127.0.0.1:${PORT}`;

beforeAll(async () => {
  serverProc = spawn("node", ["dist/src/index.js"], {
    env: {
      ...process.env,
      OAG_BACKEND_MODE: "mock",
      ANTIGRAVITY_MODEL: "gemini-2.5-pro",
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
}, 15000);

afterAll(async () => {
  if (!serverProc || serverProc.killed) {
    return;
  }
  serverProc.kill();
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    serverProc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
});

describe("POST /v1/chat/completions stream:true (#30, #31)", () => {
  it("returns SSE stream with [DONE] (#30)", async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const frames = await readSse(res);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.at(-1)).toBe("data: [DONE]");

    const chunks = parseDataFrames(frames);
    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
    const contents = chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("");
    expect(contents).toBe("[mock] hi");
  });

  it("returns SSE error frame when SDK error occurs (#31)", async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mock-Fail-After-Chunk": "1",
      },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const frames = await readSse(res);
    const errorFrame = frames.find((frame) => frame.includes('"error"'));
    expect(errorFrame).toBeTruthy();
    expect(errorFrame).toContain("upstream_api_error");
    expect(frames.at(-1)).toBe("data: [DONE]");
  });
});

async function waitForHealthz(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (serverProc.exitCode !== null) {
      throw new Error(`server exited before ready: ${serverOutput}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/healthz`);
      if (res.ok) {
        return;
      }
    } catch {
      // Retry until the spawned server binds the port.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become ready: ${serverOutput}`);
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

function parseDataFrames(frames: string[]): Array<{
  choices: Array<{ delta: { role?: string; content?: string } }>;
}> {
  return frames
    .filter((frame) => frame !== "data: [DONE]")
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as {
      choices: Array<{ delta: { role?: string; content?: string } }>;
    });
}
