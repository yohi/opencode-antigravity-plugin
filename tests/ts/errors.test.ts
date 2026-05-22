import { describe, expect, test } from "vitest";
import {
  BackendCrashedError,
  BackendTimeoutError,
  BackendPermanentlyFailedError,
  BackendResponseError,
  ProtocolError,
  NotImplementedError,
  toOpenAIError,
} from "../../src/errors.js";

describe("toOpenAIError", () => {
  test("converts BackendCrashedError to OpenAI 503 backend_unavailable with retryable message", () => {
    const { status, body } = toOpenAIError(new BackendCrashedError("python died"));
    expect(status).toBe(503);
    expect(body.error.type).toBe("backend_unavailable");
    expect(body.error.message).toBe("backend restarting, retry later");
  });

  test("converts BackendTimeoutError to 504 timeout with sanitized message", () => {
    const { status, body } = toOpenAIError(new BackendTimeoutError("60s exceeded"));
    expect(status).toBe(504);
    expect(body.error.type).toBe("timeout");
    expect(body.error.message).toBe("60s exceeded");
  });

  test("converts BackendPermanentlyFailedError to 503 with sanitized message", () => {
    const { status, body } = toOpenAIError(new BackendPermanentlyFailedError());
    expect(status).toBe(503);
    expect(body.error.type).toBe("backend_unavailable");
    expect(body.error.message).toBe("backend permanently failed");
  });

  test("converts ProtocolError to 400 invalid_request_error (keeps original message)", () => {
    const { status, body } = toOpenAIError(new ProtocolError("bad json"));
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe("bad json");
  });

  test("converts NotImplementedError to 501 not_implemented with sanitized message", () => {
    const { status, body } = toOpenAIError(new NotImplementedError("stream not supported"));
    expect(status).toBe(501);
    expect(body.error.type).toBe("not_implemented");
    expect(body.error.message).toBe("stream not supported");
  });

  test("converts BackendResponseError(-32602) to 400 invalid_request_error with rawMessage", () => {
    const { status, body } = toOpenAIError(new BackendResponseError(-32602, "field 'model' is required"));
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe("field 'model' is required");
  });

  test("converts BackendResponseError(other code) to 500 server_error with rawMessage", () => {
    const { status, body } = toOpenAIError(new BackendResponseError(-32000, "something went wrong"));
    expect(status).toBe(500);
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toBe("An internal server error occurred");
  });

  test("converts plain Error to 500 server_error with sanitized message", () => {
    const { status, body } = toOpenAIError(new Error("unexpected failure"));
    expect(status).toBe(500);
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toBe("internal server error");
  });
});
