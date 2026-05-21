import { BackendTimeoutError } from "./errors.js";
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "./types.js";

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB (design §7.4)

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
}

export interface JsonRpcClientOptions {
  write: (line: string) => void;
  warn?: (message: string) => void;
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingEntry>();

  constructor(private readonly opts: JsonRpcClientOptions) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  call(method: string, params: unknown, { timeoutMs }: { timeoutMs: number }): Promise<unknown> {
    const id = this.nextId++;
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

      this.pending.set(id, { resolve, reject, timeoutHandle });

      try {
        this.opts.write(line);
      } catch (err) {
        clearTimeout(timeoutHandle);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  handleInboundLine(line: string): void {
    const msg = parseMessage(line) as JsonRpcResponse;
    const entry = msg.id == null ? undefined : this.pending.get(msg.id);
    if (!entry) {
      this.opts.warn?.(`unknown id from backend: ${String(msg.id)} (already cleaned up)`);
      return;
    }
    // design §7.5: delete FIRST, then resolve/reject
    this.pending.delete(msg.id!);
    clearTimeout(entry.timeoutHandle);
    if ("error" in msg) {
      entry.reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
    } else {
      entry.resolve(msg.result);
    }
  }

  rejectAll(err: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timeoutHandle);
      this.pending.delete(id);
      entry.reject(err);
    }
  }
}

