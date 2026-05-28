import { afterEach, describe, expect, it } from "vitest";
import type http from "node:http";

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("GET /healthz Phase 2 fields", () => {
  it("includes backend_mode and model", async () => {
    process.env.OAG_BACKEND_MODE = "mock";
    process.env.ANTIGRAVITY_MODEL = "gemini-2.5-pro";

    const { createServer } = await import("../../src/server.js");
    const backend = {
      currentState: "ready" as const,
      restartCount: 0,
      call: async () => ({ ok: true }),
    } satisfies Parameters<typeof createServer>[0];
    server = createServer(backend);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) {
      throw new Error("no addr");
    }

    const res = await fetch(`http://127.0.0.1:${addr.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      backend_mode: string;
      model: string;
    };
    expect(body.status).toBe("ok");
    expect(body.backend_mode).toBe("mock");
    expect(body.model).toBe("gemini-2.5-pro");
  });
});
