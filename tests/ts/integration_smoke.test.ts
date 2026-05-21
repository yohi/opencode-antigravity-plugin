import { describe, expect, test } from "vitest";
import { encodeRequest } from "../../src/jsonrpc.js";

describe("phase-4 integration smoke", () => {
  test("TS jsonrpc module is importable on the integration branch", () => {
    const line = encodeRequest({ id: 1, method: "health", params: {} });
    expect(line.endsWith("\n")).toBe(true);
    
    const parsed = JSON.parse(line.trim());
    expect(parsed).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "health",
      params: {}
    });
  });
});
