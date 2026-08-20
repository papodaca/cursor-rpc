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
