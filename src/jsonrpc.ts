import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest } from "./types.js";

const MAX_MESSAGE_BYTES = 1024 * 1024; // 1 MB (design §7.4)

export function encodeRequest(args: {
  id: JsonRpcId;
  method: string;
  params: unknown;
}): string {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: args.id,
    method: args.method,
    params: args.params,
  };
  const line = JSON.stringify(req) + "\n";
  if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("jsonrpc: outbound message exceeds 1 MB");
  }
  return line;
}

export function parseMessage(line: string): JsonRpcMessage {
  const trimmed = line.replace(/\n$/, "");
  if (Buffer.byteLength(trimmed, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("jsonrpc: inbound message exceeds 1 MB");
  }
  const obj = JSON.parse(trimmed) as JsonRpcMessage;
  if (obj.jsonrpc !== "2.0") {
    throw new Error("jsonrpc: missing or invalid jsonrpc version");
  }
  return obj;
}
