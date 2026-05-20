import { describe, expect, test } from "vitest";
import { encodeRequest, parseMessage } from "../../src/jsonrpc.js";

describe("jsonrpc.encodeRequest", () => {
  test("encodes request as NDJSON (single trailing newline)", () => {
    const encoded = encodeRequest({ id: 1, method: "echo", params: { text: "hi" } });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.split("\n").length).toBe(2);
    const parsed = JSON.parse(encoded);
    expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, method: "echo", params: { text: "hi" } });
  });
});

describe("jsonrpc.parseMessage", () => {
  test("parses success response", () => {
    const msg = parseMessage('{"jsonrpc":"2.0","id":1,"result":{"text":"hi"}}');
    expect(msg).toEqual({ jsonrpc: "2.0", id: 1, result: { text: "hi" } });
  });
});
