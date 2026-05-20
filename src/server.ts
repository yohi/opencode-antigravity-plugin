import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { NotImplementedError, ProtocolError, toOpenAIError } from "./errors.js";
import type { PythonBackend } from "./backend.js";
import type { OpenAIChatRequest } from "./types.js";

export function createServer(backend: PythonBackend): http.Server {
  return http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);

    if (req.method === "GET" && req.url === "/healthz") {
      return sendJson(res, 200, {
        status: "ok",
        python_restarts: backend.restartCount,
      });
    }

    if (req.method === "GET" && req.url === "/v1/models") {
      return sendJson(res, 200, {
        object: "list",
        data: [{ id: "opencode-antigravity-echo", object: "model" }],
      });
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      try {
        const body = await readJson<OpenAIChatRequest>(req);
        if (body.stream === true) {
          throw new NotImplementedError("streaming is not supported in MVP");
        }
        const result = await backend.call("chat.completions", body);
        return sendJson(res, 200, result);
      } catch (err) {
        const { status, body } = toOpenAIError(err as Error);
        return sendJson(res, status, body);
      }
    }

    return sendJson(res, 404, {
      error: { type: "not_found", message: `no route for ${req.method} ${req.url}` },
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new ProtocolError(`invalid JSON body: ${(e as Error).message}`);
  }
}
