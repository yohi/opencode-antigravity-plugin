import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { NotImplementedError, ProtocolError, toOpenAIError } from "./errors.js";
import type { PythonBackend } from "./backend.js";
import type { OpenAIChatRequest } from "./types.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

type ServerBackend = Pick<PythonBackend, "call" | "currentState" | "restartCount">;

export function createServer(backend: ServerBackend): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const requestId = randomUUID();
      res.setHeader("X-Request-Id", requestId);

      const urlPath = req.url?.split("?")[0] ?? "";

      if (req.method === "GET" && urlPath === "/healthz") {
        const state = backend.currentState;
        if (state !== "ready") {
          return sendJson(res, 503, {
            status: state,
            python_restarts: backend.restartCount,
          });
        }
        return sendJson(res, 200, {
          status: "ok",
          python_restarts: backend.restartCount,
          backend_mode: process.env.OAG_BACKEND_MODE ?? "mock",
          model: process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
        });
      }

      if (req.method === "GET" && urlPath === "/v1/models") {
        return sendJson(res, 200, {
          object: "list",
          data: [{ id: "opencode-antigravity-echo", object: "model" }],
        });
      }

      if (req.method === "POST" && urlPath === "/v1/chat/completions") {
        try {
          const body = await readJson<OpenAIChatRequest>(req);
          if (body.stream === true) {
            throw new NotImplementedError("streaming is not supported in MVP");
          }
          const result = await backend.call("chat.completions", body);
          return sendJson(res, 200, result);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          const { status, body } = toOpenAIError(error);
          return sendJson(res, status, body);
        }
      }

      return sendJson(res, 404, {
        error: { type: "not_found", message: `no route for ${req.method} ${urlPath}` },
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const { status, body } = toOpenAIError(error);
      if (!res.headersSent) {
        return sendJson(res, status, body);
      }
    }
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      throw new ProtocolError(`request body too large (limit: ${MAX_BODY_BYTES} bytes)`);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new ProtocolError(`invalid JSON body: ${(e as Error).message}`);
  }
}
