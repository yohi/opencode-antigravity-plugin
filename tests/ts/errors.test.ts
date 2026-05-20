import { describe, expect, test } from "vitest";
import {
  BackendCrashedError,
  BackendTimeoutError,
  BackendPermanentlyFailedError,
  ProtocolError,
  toOpenAIError,
} from "../../src/errors.js";

describe("toOpenAIError", () => {
  test("converts BackendCrashedError to OpenAI 503 backend_unavailable", () => {
    const { status, body } = toOpenAIError(new BackendCrashedError("python died"));
    expect(status).toBe(503);
    expect(body.error.type).toBe("backend_unavailable");
    expect(body.error.message).toContain("python died");
  });

  test("converts BackendTimeoutError to 504 timeout", () => {
    const { status, body } = toOpenAIError(new BackendTimeoutError("60s exceeded"));
    expect(status).toBe(504);
    expect(body.error.type).toBe("timeout");
  });

  test("converts BackendPermanentlyFailedError to 503 with permanently failed message", () => {
    const { status, body } = toOpenAIError(new BackendPermanentlyFailedError());
    expect(status).toBe(503);
    expect(body.error.type).toBe("backend_unavailable");
    expect(body.error.message).toMatch(/permanently failed/);
  });

  test("converts ProtocolError to 400 invalid_request_error", () => {
    const { status, body } = toOpenAIError(new ProtocolError("bad json"));
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
  });
});
