import { describe, expect, test } from "vitest";
import {
  BackendCrashedError,
  BackendTimeoutError,
  BackendPermanentlyFailedError,
  ProtocolError,
  NotImplementedError,
  toOpenAIError,
} from "../../src/errors.js";

describe("toOpenAIError", () => {
  test("converts BackendCrashedError to OpenAI 503 backend_unavailable", () => {
    const { status, body } = toOpenAIError(new BackendCrashedError("python died"));
    expect(status).toBe(503);
    expect(body.error.type).toBe("backend_unavailable");
    expect(body.error.message).toBe("backend restarting, retry later: python died");
  });

  test("converts BackendTimeoutError to 504 timeout", () => {
    const { status, body } = toOpenAIError(new BackendTimeoutError("60s exceeded"));
    expect(status).toBe(504);
    expect(body.error.type).toBe("timeout");
  });

  test("converts BackendPermanentlyFailedError to 503 with permanently failed message", () => {
    const { status, body } = toOpenAIError(new BackendPermanentlyFailedError());
    expect(status).toBe(503);
    expect(body.error.type).toBe("permanently_failed");
    expect(body.error.message).toMatch(/permanently failed/);
  });

  test("converts ProtocolError to 400 invalid_request_error", () => {
    const { status, body } = toOpenAIError(new ProtocolError("bad json"));
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("converts NotImplementedError to 501 not_implemented", () => {
    const { status, body } = toOpenAIError(new NotImplementedError("stream not supported"));
    expect(status).toBe(501);
    expect(body.error.type).toBe("not_implemented");
  });

  test("converts plain Error to 500 server_error", () => {
    const { status, body } = toOpenAIError(new Error("unexpected failure"));
    expect(status).toBe(500);
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toBe("unexpected failure");
  });
});
