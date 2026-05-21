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
});
