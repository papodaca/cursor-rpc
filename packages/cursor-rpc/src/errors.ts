const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

export type CursorRpcErrorOptions = {
  code?: string;
  isRetryable?: boolean;
  requestId?: string;
  cause?: unknown;
};

export class CursorRpcError extends Error {
  readonly code: string;
  readonly isRetryable: boolean;
  readonly requestId: string | undefined;

  constructor(message: string, options: CursorRpcErrorOptions = {}) {
    const cause = options.cause === undefined ? undefined : redactUnknown(options.cause);
    super(redactSecrets(message), cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = options.code ?? "unknown";
    this.isRetryable = options.isRetryable ?? false;
    this.requestId = options.requestId;
  }

  static from(cause: unknown, options: Omit<CursorRpcErrorOptions, "cause"> = {}): CursorRpcError {
    return new this(messageOf(cause), { ...options, cause });
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      isRetryable: this.isRetryable,
      ...(this.requestId === undefined ? {} : { requestId: this.requestId }),
    };
  }

  [inspectCustom](): Record<string, unknown> {
    return this.toJSON();
  }
}

export class AuthenticationError extends CursorRpcError {
  constructor(message: string, options: CursorRpcErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? "unauthenticated",
      isRetryable: options.isRetryable ?? false,
    });
  }
}

export class PolicyError extends CursorRpcError {
  constructor(message: string, options: CursorRpcErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? "permission_denied",
      isRetryable: false,
    });
  }
}

export class CancelledError extends CursorRpcError {
  constructor(message = "cancelled", options: CursorRpcErrorOptions = {}) {
    super(message, {
      ...options,
      code: "cancelled",
      isRetryable: false,
    });
  }

  static fromAbort(reason?: unknown): CancelledError {
    const message = messageOf(reason);
    return new CancelledError(message === "unknown error" ? "cancelled" : message, { cause: reason });
  }
}

export class TransportUnsupportedError extends CursorRpcError {
  constructor(message: string, options: CursorRpcErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? "failed_precondition",
      isRetryable: false,
    });
  }
}

export class StreamError extends CursorRpcError {
  constructor(message: string, options: CursorRpcErrorOptions = {}) {
    super(message, {
      ...options,
      code: options.code ?? "unknown",
    });
  }
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.length > 0) {
    return cause;
  }
  return "unknown error";
}

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/(authorization:\s*)(\S+)/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|verifier)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/\bkey_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/gi, (match) => match.replace(/\/\/[^@]+@/, "//[redacted]@"));
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (value instanceof Error) {
    const copy = new Error(redactSecrets(value.message));
    copy.name = value.name;
    if (typeof value.stack === "string") {
      copy.stack = redactSecrets(value.stack);
    }
    if (value.cause !== undefined) {
      copy.cause = redactUnknown(value.cause);
    }
    return copy;
  }
  return value;
}
