import { describe, expect, test } from "vitest";
import { encodeRequest, parseMessage, JsonRpcClient } from "../../src/jsonrpc.js";
import { BackendTimeoutError } from "../../src/errors.js";

describe("jsonrpc.encodeRequest", () => {
  test("encodes request as NDJSON (single trailing newline)", () => {
    const encoded = encodeRequest({ id: 1, method: "echo", params: { text: "hi" } });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.split("\n").length).toBe(2);
    const parsed = JSON.parse(encoded);
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, method: "echo", params: { text: "hi" } });
  });

  test("omits params when undefined", () => {
    const encoded = encodeRequest({ id: 1, method: "noparams" });
    const parsed = JSON.parse(encoded);
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, method: "noparams" });
    expect(parsed).not.toHaveProperty("params");
  });

  test("throws when outbound message exceeds 1 MB", () => {
    const largeParams = "a".repeat(1024 * 1024);
    expect(() =>
      encodeRequest({ id: 1, method: "large", params: largeParams })
    ).toThrow("jsonrpc: outbound message exceeds 1 MB");
  });
});

describe("jsonrpc.parseMessage", () => {
  test("parses success response", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"text":"hi"}}');
    expect(msg).toEqual({ jsonrpc: "2.0", id: 1, result: { text: "hi" } });
  });

  test("parses error response", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid Request"}}');
    expect(msg).toHaveProperty("error");
    if ("error" in msg) {
      expect(msg.error.code).toBe(-32600);
    }
  });

  test("parses notification with object params", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","method":"notify","params":{"key":"val"}}');
    expect(msg).toEqual({ jsonrpc: "2.0", method: "notify", params: { key: "val" } });
  });

  test("parses notification with array params", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","method":"notify","params":["val1","val2"]}');
    expect(msg).toEqual({ jsonrpc: "2.0", method: "notify", params: ["val1", "val2"] });
  });

  test("accepts input with trailing CRLF", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":true}\r\n');
    expect(msg).toEqual({ jsonrpc: "2.0", id: 1, result: true });
  });

  test("rejects invalid jsonrpc version", () => {
    expect(() => parseMessage('{"jsonrpc":"1.0","id":1,"method":"foo"}')).toThrow(
      "jsonrpc: missing or invalid jsonrpc version"
    );
  });

  test("throws on malformed JSON", () => {
    expect(() => parseMessage('{"jsonrpc":"2.0",')).toThrow();
  });

  test("throws on JSON 'null' input", () => {
    expect(() => parseMessage("null")).toThrow("jsonrpc: missing or invalid jsonrpc version");
  });

  test("throws when inbound message exceeds 1 MB", () => {
    const largeMessage = '{"jsonrpc":"2.0","id":1,"result":"' + "a".repeat(1024 * 1024) + '"}';
    expect(() => parseMessage(largeMessage)).toThrow("jsonrpc: inbound message exceeds 1 MB");
  });
});

describe("JsonRpcClient", () => {
  test("resolves promise by id when response arrives", async () => {
    const sent: string[] = [];
    const client = new JsonRpcClient({ write: (line) => sent.push(line) });
    const promise = client.call("echo", { text: "hi" }, { timeoutMs: 1000 });
    expect(sent.length).toBe(1);
    const sentReq = JSON.parse(sent[0]!);
    client.handleInboundLine(
      JSON.stringify({ jsonrpc: "2.0", id: sentReq.id, result: { text: "hi" } }),
    );
    await expect(promise).resolves.toEqual({ text: "hi" });
  });

  test("rejects with error response", async () => {
    const sent: string[] = [];
    const client = new JsonRpcClient({ write: (line) => sent.push(line) });
    const promise = client.call("bad", {}, { timeoutMs: 1000 });
    const id = JSON.parse(sent[0]!).id;
    client.handleInboundLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      }),
    );
    await expect(promise).rejects.toThrow(/Method not found/);
  });

  test("timeout rejects, removes entry from pending map, ignores late response", async () => {
    const sent: string[] = [];
    const warnLogs: string[] = [];
    const client = new JsonRpcClient({
      write: (line) => sent.push(line),
      warn: (msg) => warnLogs.push(msg),
    });
    const promise = client.call("slow", {}, { timeoutMs: 10 });
    await expect(promise).rejects.toBeInstanceOf(BackendTimeoutError);
    expect(client.pendingCount).toBe(0);

    const id = JSON.parse(sent[0]!).id;
    client.handleInboundLine(
      JSON.stringify({ jsonrpc: "2.0", id, result: { text: "late" } }),
    );
    expect(warnLogs.some((m) => m.includes("unknown id"))).toBe(true);
    expect(client.pendingCount).toBe(0);
  });

  test("handleInboundLine catches parse errors and warns instead of throwing", () => {
    const warnLogs: string[] = [];
    const client = new JsonRpcClient({
      write: () => {},
      warn: (msg) => warnLogs.push(msg),
    });

    // Malformed JSON should not throw
    expect(() => {
      client.handleInboundLine('{"jsonrpc":"2.0",');
    }).not.toThrow();

    expect(warnLogs.length).toBe(1);
    expect(warnLogs[0]).toContain("handleInboundLine failed to parse message");
  });

  test("call returns Promise.reject for invalid timeoutMs", async () => {
    const client = new JsonRpcClient({ write: () => {} });
    await expect(client.call("foo", {}, { timeoutMs: -1 })).rejects.toThrow(RangeError);
    await expect(client.call("foo", {}, { timeoutMs: Infinity })).rejects.toThrow(RangeError);
  });

  test("handleInboundLine rejects dual-field response (result AND error)", () => {
    const warnLogs: string[] = [];
    const client = new JsonRpcClient({
      write: () => {},
      warn: (msg) => warnLogs.push(msg),
    });

    client.handleInboundLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: "ok",
      error: { code: -32000, message: "oops" }
    }));

    expect(warnLogs.some(m => m.includes("non-response message shape"))).toBe(true);
  });

  test("handles malformed error objects in response", async () => {
    const sent: string[] = [];
    const client = new JsonRpcClient({ write: (line) => sent.push(line) });
    
    // Case 1: error is not an object
    const promise1 = client.call("test1", {}, { timeoutMs: 1000 });
    const id1 = JSON.parse(sent[0]!).id;
    client.handleInboundLine(JSON.stringify({
      jsonrpc: "2.0", id: id1, error: "not an object"
    }));
    await expect(promise1).rejects.toThrow(/malformed error from backend/);

    // Case 2: error.code is not a number
    const promise2 = client.call("test2", {}, { timeoutMs: 1000 });
    const id2 = JSON.parse(sent[1]!).id;
    client.handleInboundLine(JSON.stringify({
      jsonrpc: "2.0", id: id2, error: { code: "not a number", message: "bad code" }
    }));
    await expect(promise2).rejects.toThrow(/\[-32000\] bad code/);

    // Case 3: error.message is not a string (converts to string)
    const promise3 = client.call("test3", {}, { timeoutMs: 1000 });
    const id3 = JSON.parse(sent[2]!).id;
    client.handleInboundLine(JSON.stringify({
      jsonrpc: "2.0", id: id3, error: { code: -32603, message: { complex: "object" } }
    }));
    await expect(promise3).rejects.toThrow(/\[-32603\] \[object Object\]/);
  });
});
