import type { PiAssistantMessage, PiModel } from "./types.js";

const OVERFLOW_PATTERN =
  /context.?length|context.?window|maximum context|prompt is too long|too many tokens|token limit/i;
const RATE_LIMIT_PATTERN = /rate limit|too many requests|429/i;
const AUTH_PATTERN = /unauthenticated|unauthorized|expired/i;
const STALL_PATTERN = /stall_detector|deadline_exceeded/i;
const HTTP11_PATTERN = /http\/?1\.1|http2|HTTP\/2/i;
const SECRET_PATTERN = /Bearer\s+\S+|verifier=[^&\s]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "[redacted]");
}

export function overflowHandler(
  event: { message: { role?: string; stopReason?: string; errorMessage?: string; provider?: string } },
  ctx: { model?: PiModel },
): { message: PiAssistantMessage } | void {
  const message = event.message;
  if (message.role !== "assistant") {
    return;
  }
  if (message.stopReason !== "error") {
    return;
  }
  if (message.provider !== "cursor-rpc" && ctx.model?.provider !== "cursor-rpc") {
    return;
  }
  const errorMessage = message.errorMessage ?? "";
  if (RATE_LIMIT_PATTERN.test(errorMessage) || AUTH_PATTERN.test(errorMessage) || STALL_PATTERN.test(errorMessage) || HTTP11_PATTERN.test(errorMessage)) {
    return;
  }
  if (!OVERFLOW_PATTERN.test(errorMessage)) {
    return;
  }
  const redacted = redactSecrets(errorMessage);
  const rewritten = redacted.includes("context_length_exceeded")
    ? redacted
    : `context_length_exceeded: ${redacted}`;
  return {
    message: { ...(message as PiAssistantMessage), errorMessage: rewritten },
  };
}
