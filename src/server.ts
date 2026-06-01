import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { NotImplementedError, ProtocolError, toOpenAIError } from "./errors.js";
import type { PythonBackend } from "./backend.js";
import { getChatCompletionsParamsSchema, type ChatCompletionsParams } from "./schemas.js";
import type { ChatCompletionChunkDelta, OpenAIChatRequest } from "./types.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

type StreamingFinal = { finish_reason: string; usage: Record<string, unknown> };
type ServerBackend = Pick<PythonBackend, "call" | "currentState" | "restartCount"> &
  Partial<Pick<PythonBackend, "streamingCall">>;

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
            backend_mode: process.env.OAG_BACKEND_MODE ?? "mock",
            model: process.env.ANTIGRAVITY_MODEL ?? "gemini-2.5-pro",
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
          const parsed = getChatCompletionsParamsSchema().safeParse(body);
          if (!parsed.success) {
            return sendJson(res, 400, {
              error: { type: "invalid_request_error", message: parsed.error.message },
            });
          }
          const params = parsed.data;

          if (params.stream === true) {
            return await handleStreamingChatCompletion(res, backend, params, requestId);
          }
          const result = await backend.call("chat.completions", params);
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

async function handleStreamingChatCompletion(
  res: ServerResponse,
  backend: ServerBackend,
  params: ChatCompletionsParams,
  requestId: string,
): Promise<void> {
  const model = params.model;
  const created = Math.floor(Date.now() / 1000);
  const streamId = `chatcmpl-${requestId}`;

  // Always write SSE headers first for stream:true
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (!backend.streamingCall) {
    const error = new NotImplementedError("streaming is not supported by backend");
    const mapped = toOpenAIError(error);
    await writeSseData(res, { error: mapped.body.error });
    endResponse(res);
    return;
  }

  try {
    const finalMeta = await backend.streamingCall<StreamingFinal>(
      "chat.completions",
      params,
      async (delta) =>
        await writeSseChunk(res, streamId, model, created, normalizeDelta(delta), null),
    );
    await writeSseChunk(res, streamId, model, created, {}, finalMeta.finish_reason, finalMeta.usage);
    await writeSseDone(res);
    endResponse(res);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const mapped = toOpenAIError(error);
    await writeSseData(res, { error: mapped.body.error });
    endResponse(res);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function writeSseChunk(
  res: ServerResponse,
  id: string,
  model: string,
  created: number,
  delta: ChatCompletionChunkDelta,
  finishReason: string | null,
  usage?: Record<string, unknown>,
): void {
  writeSseData(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  });
}

function writeSseDone(res: ServerResponse): void {
  writeRawSse(res, "data: [DONE]\n\n");
}

function writeSseData(res: ServerResponse, payload: unknown): void {
  writeRawSse(res, `data: ${JSON.stringify(payload)}\n\n`);
}

function writeRawSse(res: ServerResponse, frame: string): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  res.write(frame);
}

function endResponse(res: ServerResponse): void {
  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }
}

function normalizeDelta(delta: unknown): ChatCompletionChunkDelta {
  if (delta === null || typeof delta !== "object") {
    return {};
  }
  const record = delta as Record<string, unknown>;
  const normalized: ChatCompletionChunkDelta = {};
  if (record.role === "assistant") {
    normalized.role = "assistant";
  }
  if (typeof record.content === "string") {
    normalized.content = record.content;
  }
  return normalized;
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
