import { logger } from "./logger.js";

export class BackendCrashedError extends Error {
  readonly name = "BackendCrashedError";
  constructor(message = "backend crashed") {
    super(message);
  }
}

export class BackendTimeoutError extends Error {
  readonly name = "BackendTimeoutError";
  constructor(message = "backend timed out") {
    super(message);
  }
}

export class BackendPermanentlyFailedError extends Error {
  readonly name = "BackendPermanentlyFailedError";
  constructor(message = "backend permanently failed") {
    super(message);
  }
}

export class BackendResponseError extends Error {
  readonly name = "BackendResponseError";
  constructor(
    public readonly code: number,
    public readonly rawMessage: string
  ) {
    super(`[${code}] ${rawMessage}`);
  }
}

export class ProtocolError extends Error {
  readonly name = "ProtocolError";
}

export class NotImplementedError extends Error {
  readonly name = "NotImplementedError";
}

export interface OpenAIErrorBody {
  error: { type: string; message: string };
}

export function toOpenAIError(err: Error): { status: number; body: OpenAIErrorBody } {
  if (err instanceof BackendPermanentlyFailedError) {
    logger.error({ err }, "Backend permanently failed");
    return {
      status: 503,
      body: { error: { type: "backend_unavailable", message: "backend permanently failed" } },
    };
  }
  if (err instanceof BackendCrashedError) {
    logger.error({ err }, "Backend crashed");
    return {
      status: 503,
      body: {
        error: {
          type: "backend_unavailable",
          message: "backend restarting, retry later",
        },
      },
    };
  }
  if (err instanceof BackendTimeoutError) {
    logger.error({ err }, "Backend timeout");
    return { status: 504, body: { error: { type: "timeout", message: err.message } } };
  }
  if (err instanceof BackendResponseError) {
    if (err.code === -32602) {
      logger.warn({ err }, "Backend invalid params");
      return {
        status: 400,
        body: { error: { type: "invalid_request_error", message: err.rawMessage } },
      };
    }
    logger.error({ err }, "Backend internal error");
    return {
      status: 500,
      body: { error: { type: "server_error", message: "An internal server error occurred" } },
    };
  }
  if (err instanceof NotImplementedError) {
    logger.warn({ err }, "Not implemented");
    return {
      status: 501,
      body: { error: { type: "not_implemented", message: err.message } },
    };
  }
  if (err instanceof ProtocolError) {
    logger.warn({ err }, "Protocol error");
    return {
      status: 400,
      body: { error: { type: "invalid_request_error", message: err.message } },
    };
  }
  logger.error({ err }, "Unexpected server error");
  return { status: 500, body: { error: { type: "server_error", message: "internal server error" } } };
}
