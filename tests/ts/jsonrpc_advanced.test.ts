import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { JsonRpcClient } from "../../src/jsonrpc.js";
import { BackendTimeoutError } from "../../src/errors.js";

function makeClient() {
  const writes: string[] = [];
  const warnings: string[] = [];
  const client = new JsonRpcClient({
    write: (line) => writes.push(line),
    warn: (message) => warnings.push(message),
  });
  return { client, writes, warnings };
}

describe("JsonRpcClient advanced scenarios", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("idle timer is not armed before first chunk and request timeout still runs", async () => {
    const { client } = makeClient();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    const promise = client.streamingCall("test", {}, onChunk);
    
    // Idle timeout is NOT armed until first chunk
    // Default idle timeout is 30s.
    vi.advanceTimersByTime(35000); 
    
    // Check it hasn't timed out yet (idle timer didn't fire)
    expect(client.pendingCount).toBe(1);

    // Default request timeout is 60s. Total time now 35s.
    // Advance remaining 25s + 1ms to trigger request timeout.
    vi.advanceTimersByTime(25001);

    await expect(promise).rejects.toThrow(/call timed out after 60000ms/);
    expect(client.pendingCount).toBe(0);
  });

  it("arms idle timer on first chunk and times out if idle", async () => {
    const { client, writes } = makeClient();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    const promise = client.streamingCall("test", {}, onChunk);
    const requestId = JSON.parse(writes[0]!).id;

    // Send first chunk
    await client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      method: "test.chunk",
      params: { request_id: requestId, delta: { content: "a" } }
    }) + "\n");

    expect(onChunk).toHaveBeenCalledWith({ content: "a" });

    // Now idle timer is armed (default 30s)
    vi.advanceTimersByTime(31000);
    await Promise.resolve(); // Flush microtasks

    await expect(promise).rejects.toThrow(BackendTimeoutError);
    await expect(promise).rejects.toThrow("stream idle exceeded 30000ms");
  });

  it("resets idle timer on subsequent chunks", async () => {
    const { client, writes } = makeClient();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    const promise = client.streamingCall("test", {}, onChunk);
    const requestId = JSON.parse(writes[0]!).id;

    // Chunk 1 at T=0
    await client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      method: "test.chunk",
      params: { request_id: requestId, delta: { content: "a" } }
    }) + "\n");

    vi.advanceTimersByTime(20000);

    // Chunk 2 at T=20s
    await client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      method: "test.chunk",
      params: { request_id: requestId, delta: { content: "b" } }
    }) + "\n");

    vi.advanceTimersByTime(20000);
    // Total 40s passed, but idle was only 20s each time. Should still be alive.
    expect(client.pendingCount).toBe(1);

    vi.advanceTimersByTime(11000);
    await Promise.resolve();
    // Now idle exceeded 30s since last chunk.
    await expect(promise).rejects.toThrow(BackendTimeoutError);
  });

  it("respects overall request timeout even with chunks", async () => {
    const { client, writes } = makeClient();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    const promise = client.streamingCall("test", {}, onChunk);
    const requestId = JSON.parse(writes[0]!).id;

    // Keep sending chunks every 10s
    for (let i = 0; i < 7; i++) {
      await client._ingest(JSON.stringify({
        jsonrpc: "2.0",
        method: "test.chunk",
        params: { request_id: requestId, delta: { content: String(i) } }
      }) + "\n");
      vi.advanceTimersByTime(10000);
    }

    await Promise.resolve();
    // Total time 70s. Default request timeout is 60s.
    await expect(promise).rejects.toThrow("call timed out after 60000ms");
  });

  it("handles onChunk exceptions gracefully", async () => {
    const { client, writes, warnings } = makeClient();
    const onChunk = vi.fn().mockRejectedValue(new Error("callback crash"));

    const promise = client.streamingCall("test", {}, onChunk);
    const requestId = JSON.parse(writes[0]!).id;

    await client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      method: "test.chunk",
      params: { request_id: requestId, delta: { content: "!" } }
    }) + "\n").catch(() => {});

    await expect(promise).rejects.toThrow("callback crash");
    expect(warnings.some(w => w.includes("onChunk callback threw error"))).toBe(true);
    expect(client.pendingCount).toBe(0);
  });

  it("matches request_id regardless of number vs string type", async () => {
    const { client, writes } = makeClient();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    const promise = client.streamingCall("test", {}, onChunk);
    const requestId = JSON.parse(writes[0]!).id; // This is a number in our client

    expect(typeof requestId).toBe("number");

    // Backend sends it as a string
    await client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      method: "test.chunk",
      params: { request_id: String(requestId), delta: { content: "normalized" } }
    }) + "\n");

    expect(onChunk).toHaveBeenCalledWith({ content: "normalized" });
    
    // Resolve it
    await client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: "done"
    }) + "\n");

    await expect(promise).resolves.toBe("done");
  });

  it("distinguishes unknown ID from non-streaming request warning", async () => {
    const { client, warnings } = makeClient();
    
    // 1. Unknown ID
    await client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      method: "test.chunk",
      params: { request_id: 999, delta: {} }
    }) + "\n");
    expect(warnings.some(w => w.includes("unknown notification id: 999"))).toBe(true);

    // 2. Non-streaming request
    const promise = client.call("test", {}, { timeoutMs: 1000 });
    const requestId = (client as any).lastRequestId;

    await client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      method: "test.chunk",
      params: { request_id: requestId, delta: {} }
    }) + "\n");
    expect(warnings.some(w => w.includes("received streaming chunk for non-streaming request"))).toBe(true);

    // Settle the promise to avoid leaks
    await client._ingest(JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: "ok"
    }) + "\n");
    await expect(promise).resolves.toBe("ok");
  });
});
