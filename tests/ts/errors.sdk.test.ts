import { describe, expect, it } from "vitest";
import { BackendResponseError, toOpenAIError } from "../../src/errors.js";

describe("toOpenAIError SDK mapping", () => {
  it("maps -32010 to 401 authentication_error", () => {
    const { status, body } = toOpenAIError(new BackendResponseError(-32010, "auth failed"));
    expect(status).toBe(401);
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.message).toBe("auth failed");
  });

  it("maps -32011 to 429 rate_limit_error", () => {
    const { status, body } = toOpenAIError(new BackendResponseError(-32011, "rate limit"));
    expect(status).toBe(429);
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.message).toBe("rate limit");
  });

  it("maps -32012 to 400 invalid_request_error", () => {
    const { status, body } = toOpenAIError(new BackendResponseError(-32012, "model not found"));
    expect(status).toBe(400);
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe("model not found");
  });

  it("maps -32013 to 502 bad_gateway", () => {
    const { status, body } = toOpenAIError(new BackendResponseError(-32013, "api err"));
    expect(status).toBe(502);
    expect(body.error.type).toBe("bad_gateway");
    expect(body.error.message).toBe("api err");
  });

  it("maps -32014 to 504 timeout", () => {
    const { status, body } = toOpenAIError(new BackendResponseError(-32014, "timeout"));
    expect(status).toBe(504);
    expect(body.error.type).toBe("timeout");
    expect(body.error.message).toBe("timeout");
  });

  it("maps -32015 to 502 bad_gateway", () => {
    const { status, body } = toOpenAIError(new BackendResponseError(-32015, "conn refused"));
    expect(status).toBe(502);
    expect(body.error.type).toBe("bad_gateway");
    expect(body.error.message).toBe("conn refused");
  });
});
