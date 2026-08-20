import type { ServerResponse } from "node:http";

export type OpenAIError = {
  message: string;
  type: string;
  param: string | null;
  code: string | null;
};

export type OpenAIErrorBody = {
  error: OpenAIError;
};

export function openaiError(error: OpenAIError): OpenAIErrorBody {
  return {
    error: {
      message: redactSecrets(error.message),
      type: error.type,
      param: error.param,
      code: error.code,
    },
  };
}

export const invalidApiKeyError = openaiError({
  message: "Invalid API key",
  type: "invalid_request_error",
  param: null,
  code: "invalid_api_key",
});

export const invalidJsonError = openaiError({
  message: "Invalid JSON body",
  type: "invalid_request_error",
  param: null,
  code: "invalid_json",
});

export const notFoundError = openaiError({
  message: "Invalid URL",
  type: "invalid_request_error",
  param: null,
  code: null,
});

export const internalError = openaiError({
  message: "Internal server error",
  type: "api_error",
  param: null,
  code: "internal_error",
});

export class HttpError extends Error {
  readonly status: number;
  readonly body: OpenAIErrorBody;

  constructor(status: number, body: OpenAIErrorBody) {
    super(body.error.message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export type MappedCursorError = { kind: "cancelled" } | { kind: "http"; error: HttpError; pin: boolean };

export function mapCursorError(error: unknown): MappedCursorError {
  if (error instanceof HttpError) {
    return { kind: "http", error, pin: false };
  }
  if (isNamedError(error, "CancelledError")) {
    return { kind: "cancelled" };
  }
  if (isNamedError(error, "AuthenticationError") || isNamedError(error, "PolicyError")) {
    return {
      kind: "http",
      pin: true,
      error: new HttpError(
        502,
        openaiError({
          message: "Cursor upstream request failed; this is not caused by the inbound Bearer token",
          type: "api_error",
          param: null,
          code: "cursor_upstream",
        }),
      ),
    };
  }
  if (isNamedError(error, "TransportUnsupportedError") || (isNamedError(error, "StreamError") && isRetryable(error))) {
    return {
      kind: "http",
      pin: false,
      error: new HttpError(
        503,
        openaiError({
          message: "Cursor upstream temporarily unavailable",
          type: "api_error",
          param: null,
          code: "cursor_unavailable",
        }),
      ),
    };
  }
  return {
    kind: "http",
    pin: false,
    error: new HttpError(500, internalError),
  };
}

function isNamedError(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name;
}

function isRetryable(error: Error): boolean {
  return "isRetryable" in error && error.isRetryable === true;
}

export function writeJson(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  if (res.writableEnded) {
    return;
  }
  res.statusCode = status;
  res.setHeader("x-request-id", requestId);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/(authorization:\s*)(\S+)/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|verifier)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bkey_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/gi, (match) => match.replace(/\/\/[^@]+@/, "//[redacted]@"));
}
