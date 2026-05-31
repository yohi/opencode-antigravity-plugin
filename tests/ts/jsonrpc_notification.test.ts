import { describe, expect, it, vi } from "vitest";
import { JsonRpcClient } from "../../src/jsonrpc.js";

function makeClient() {
  const writes: string[] = [];
  const warnings: string[] = [];
  const client = new JsonRpcClient({
    write: (line) => writes.push(line),
    warn: (message) => warnings.push(message),
  });
  return { client, writes, warnings };
}

describe("JsonRpcClient notification dispatch", () => {
  it("dispatches chunk to onChunk by request_id (#26)", async () => {
    const { client, writes } = makeClient();
    const onChunk = vi.fn().mockResolvedValue(undefined);

    const promise = client.streamingCall("chat.completions", { stream: true }, onChunk);
    const request = JSON.parse(writes[0]!);

    expect(client.lastRequestId).toBe(request.id);

    await client._ingest(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "chat.completions.chunk",
        params: { request_id: request.id, delta: { content: "x" } },
      }) + "\n",
    );

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledWith({ content: "x" });

    await client._ingest(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { finish_reason: "stop" },
      }) + "\n",
    );

    await expect(promise).resolves.toEqual({ finish_reason: "stop" });
  });

  it("ignores unknown request_id with warning (#27)", async () => {
    const { client, warnings } = makeClient();

    await client._ingest(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "chat.completions.chunk",
        params: { request_id: "unknown", delta: { content: "x" } },
      }) + "\n",
    );

    expect(warnings.some((message) => message.includes("unknown notification id"))).toBe(true);
  });
});
