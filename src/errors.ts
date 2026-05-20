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
    return {
      status: 503,
      body: { error: { type: "backend_unavailable", message: err.message } },
    };
  }
  if (err instanceof BackendCrashedError) {
    return {
      status: 503,
      body: {
        error: {
          type: "backend_unavailable",
          message: `backend restarting, retry later: ${err.message}`,
        },
      },
    };
  }
  if (err instanceof BackendTimeoutError) {
    return { status: 504, body: { error: { type: "timeout", message: err.message } } };
  }
  if (err instanceof NotImplementedError) {
    return {
      status: 501,
      body: { error: { type: "not_implemented", message: err.message } },
    };
  }
  if (err instanceof ProtocolError) {
    return {
      status: 400,
      body: { error: { type: "invalid_request_error", message: err.message } },
    };
  }
  return { status: 500, body: { error: { type: "server_error", message: err.message } } };
}
