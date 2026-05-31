import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type http from "node:http";
import { PythonBackend } from "../../src/backend.js";
import { createServer } from "../../src/server.js";

let backend: PythonBackend;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  backend = new PythonBackend({
    pythonBin: process.env.PYTHON_BIN ?? "python",
    moduleName: "opencode_antigravity",
    cwd: process.cwd(),
    healthTimeoutMs: 5000,
    callTimeoutMs: 10000,
    maxRestarts: 3,
    backoffMs: [1000, 2000, 4000],
  });
  await backend.start();
  server = createServer(backend);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (typeof addr === "object" && addr !== null) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  } else {
    throw new Error(`Failed to determine server address: ${JSON.stringify(addr)}`);
  }
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((r) => server.close(() => r()));
  }
  if (backend) {
    await backend.stop();
  }
});

describe("E2E", () => {
  test("POST /v1/chat/completions returns echo result (#19)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      model: string;
    };
    expect(body.model).toBe("gemini-2.5-pro");
    expect(body.choices.length).toBeGreaterThan(0);
    expect(body.choices[0]!.message.content).toBe("[mock] hi");
  });

  test("GET /healthz returns ok with restart count (#20)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; python_restarts: number };
    expect(body.status).toBe("ok");
    expect(typeof body.python_restarts).toBe("number");
  });

  test("POST with stream:true returns SSE chunks and done (#30)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const frames = text.split("\n\n").filter((frame) => frame.length > 0);
    expect(frames.at(-1)).toBe("data: [DONE]");

    const chunks = frames
      .filter((frame) => frame !== "data: [DONE]")
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as {
        object: string;
        model: string;
        choices: { delta: { role?: string; content?: string }; finish_reason: string | null }[];
      });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.object).toBe("chat.completion.chunk");
    expect(chunks[0]?.model).toBe("gemini-2.5-pro");
    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.content === "[mock] ")).toBe(true);
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.content === "hi")).toBe(true);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  test("POST with stream:true returns JSON 400 before SSE for invalid params (#30)", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "wrong-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("invalid_request_error");
  });
});
