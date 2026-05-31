import { BackendResponseError, BackendTimeoutError } from "./errors.js";
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "./types.js";

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB (design §7.4)
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

export function encodeRequest(args: {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}): string {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: args.id,
    method: args.method,
    ...(args.params !== undefined ? { params: args.params } : {}),
  };
  const line = JSON.stringify(req) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("jsonrpc: outbound message exceeds 1 MB");
  }
  return line;
}

export function parseMessage(line: string): JsonRpcMessage {
  if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("jsonrpc: inbound message exceeds 1 MB");
  }
  const trimmed = line.trimEnd();
  const obj = JSON.parse(trimmed) as JsonRpcMessage;
  if (obj === null || typeof obj !== "object" || obj.jsonrpc !== "2.0") {
    throw new Error("jsonrpc: missing or invalid jsonrpc version");
  }
  return obj;
}

interface PendingEntry {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout;
  idleTimeoutHandle?: NodeJS.Timeout;
  idleTimeoutMs?: number;
  onChunk?: (delta: unknown) => Promise<void>;
  chunkChain: Promise<void>;
}

export interface JsonRpcClientOptions {
  write: (line: string) => void;
  warn?: (message: string) => void;
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingEntry>();

  /** @internal Test hook exposing the most recently generated request id. */
  public lastRequestId: JsonRpcId | undefined;

  constructor(private readonly opts: JsonRpcClientOptions) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  call(method: string, params: unknown, { timeoutMs }: { timeoutMs: number }): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new RangeError("timeoutMs must be a finite number > 0"));
    }
    const id = this.nextId++;
    this.lastRequestId = id;

    return new Promise((resolve, reject) => {
      let line: string;
      try {
        line = encodeRequest({ id, method, params });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const timeoutHandle = setTimeout(() => {
        // design §7.5: delete FIRST, then reject
        this.pending.delete(id);
        reject(new BackendTimeoutError(`call timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timeoutHandle,
        chunkChain: Promise.resolve(),
      });

      try {
        this.opts.write(line);
      } catch (err) {
        clearTimeout(timeoutHandle);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private notificationChain: Promise<void> = Promise.resolve();

  async handleInboundLine(line: string): Promise<void> {
    let msg: JsonRpcMessage;
    try {
      msg = parseMessage(line);
    } catch (err) {
      this.opts.warn?.(
        `jsonrpc: handleInboundLine failed to parse message: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (isNotification(msg)) {
      // design §7.x: ensure sequential execution of notifications
      this.notificationChain = this.notificationChain.then(() => this.handleNotification(msg));
      await this.notificationChain;
      return;
    }

    // Explicitly validate shape: must NOT be a request (no 'method'),
    // and must be a response (has EXACTLY one of 'result' or 'error').
    if (!isResponseMessage(msg)) {
      this.opts.warn?.(
        `jsonrpc: handleInboundLine received non-response message shape (id: ${String("id" in msg ? msg.id : undefined)})`,
      );
      return;
    }

    const responseId = msg.id;
    if (responseId == null) {
      this.opts.warn?.("jsonrpc: backend returned error with id: null (likely request parse error)");
      return;
    }

    let entry = this.pending.get(responseId);
    if (!entry && typeof responseId === "string") {
      const numId = Number(responseId);
      if (!Number.isNaN(numId)) {
        entry = this.pending.get(numId);
      }
    }

    if (!entry) {
      this.opts.warn?.(`unknown id from backend: ${String(responseId)} (already cleaned up)`);
      return;
    }

    // design §7.5: delete FIRST, then clear timers, then resolve/reject
    this.pending.delete(responseId);
    clearTimeout(entry.timeoutHandle);
    if (entry.idleTimeoutHandle) {
      clearTimeout(entry.idleTimeoutHandle);
    }

    if ("error" in msg) {
      const error = msg.error;
      let code = -32000; // General non-standard backend error fallback
      let message = "malformed error from backend";

      if (error && typeof error === "object") {
        if (typeof error.code === "number") {
          code = error.code;
        }
        if (typeof error.message === "string") {
          message = error.message;
        } else if (error.message !== undefined) {
          message = String(error.message);
        }
      }
      entry.reject(new BackendResponseError(code, message));
    } else {
      // design §7.x: ensure all chunks are processed before resolving
      entry.chunkChain.then(() => entry.resolve(msg.result));
    }
  }

  streamingCall<T = { finish_reason: string; usage: object }>(
    method: string,
    params: unknown,
    onChunk: (delta: unknown) => Promise<void>,
  ): Promise<T> {
    const requestTimeoutMs = timeoutMsFromEnv(
      "OAG_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const idleTimeoutMs = timeoutMsFromEnv(
      "OAG_STREAM_IDLE_TIMEOUT_MS",
      DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    );
    const id = this.nextId++;
    this.lastRequestId = id;

    return new Promise<T>((resolve, reject) => {
      let line: string;
      try {
        line = encodeRequest({ id, method, params });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const timeoutHandle = setTimeout(() => {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        if (entry?.idleTimeoutHandle) {
          clearTimeout(entry.idleTimeoutHandle);
        }
        reject(new BackendTimeoutError(`call timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);

      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
        timeoutHandle,
        idleTimeoutMs,
        onChunk,
        chunkChain: Promise.resolve(),
      });

      try {
        this.opts.write(line);
      } catch (err) {
        clearTimeout(timeoutHandle);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** @internal Test hook for injecting a raw inbound NDJSON line. */
  async _ingest(line: string): Promise<void> {
    await this.handleInboundLine(line);
  }

  rejectAll(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timeoutHandle);
      if (entry.idleTimeoutHandle) {
        clearTimeout(entry.idleTimeoutHandle);
      }
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  private async handleNotification(msg: JsonRpcNotification): Promise<void> {
    if (msg.params === null || typeof msg.params !== "object") {
      this.opts.warn?.(`jsonrpc: malformed notification params for ${msg.method}`);
      return;
    }

    const params = msg.params as Record<string, unknown>;
    const requestId = params.request_id as JsonRpcId;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      this.opts.warn?.(`jsonrpc: malformed notification id for ${msg.method}`);
      return;
    }

    let entry = this.pending.get(requestId);
    if (!entry && typeof requestId === "string") {
      const numId = Number(requestId);
      if (!Number.isNaN(numId)) {
        entry = this.pending.get(numId);
      }
    }

    if (!entry) {
      this.opts.warn?.(`jsonrpc: unknown notification id: ${String(requestId)}`);
      return;
    }
    if (!entry.onChunk) {
      this.opts.warn?.(
        `jsonrpc: received streaming chunk for non-streaming request: ${String(requestId)}`,
      );
      return;
    }

    try {
      entry.chunkChain = entry.chunkChain.then(() => entry.onChunk!(params.delta));
      await entry.chunkChain;
    } catch (err) {
      this.pending.delete(requestId);
      clearTimeout(entry.timeoutHandle);
      if (entry.idleTimeoutHandle) {
        clearTimeout(entry.idleTimeoutHandle);
      }
      const error = err instanceof Error ? err : new Error(String(err));
      entry.reject(error);
      this.opts.warn?.(
        `jsonrpc: onChunk callback threw error for id ${String(requestId)}: ${error.message}`,
      );
      return;
    }

    this.armIdleTimer(requestId, entry);
  }

  private armIdleTimer(id: JsonRpcId, entry: PendingEntry): void {
    const idleTimeoutMs = entry.idleTimeoutMs;
    if (idleTimeoutMs === undefined) {
      return;
    }

    if (entry.idleTimeoutHandle) {
      clearTimeout(entry.idleTimeoutHandle);
    }

    entry.idleTimeoutHandle = setTimeout(() => {
      this.pending.delete(id);
      clearTimeout(entry.timeoutHandle);
      entry.reject(new BackendTimeoutError(`stream idle exceeded ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
  }
}

function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

function isResponseMessage(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return !("method" in msg) && (("result" in msg) !== ("error" in msg));
}

function timeoutMsFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
