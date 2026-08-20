import { createClient, Code, ConnectError, type Client, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport, Http2SessionManager } from "@connectrpc/connect-node";
import type { DescMessage, DescMethodUnary, DescService, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import { CancelledError, CursorRpcError } from "../errors.js";
import { createCodecFallbackTransport, createCodecMemory, type CodecMemory } from "./codec.js";
import { createHeaderInterceptor, type HeaderProviders } from "./headers.js";

const PING_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = 20_000;

export type OriginConnection = {
  origin: string;
  jsonTransport: Transport;
  binaryTransport: Transport;
  transport: Transport;
  sessionManager: Http2SessionManager;
  codecMemory: CodecMemory;
  close: () => void;
};

export type CreateOriginConnectionOptions = HeaderProviders & {
  interceptors?: Interceptor[];
  insecure?: boolean;
};

export function createOriginConnection(
  origin: string,
  options: CreateOriginConnectionOptions = {},
): OriginConnection {
  const sessionManager = new Http2SessionManager(origin, {
    pingIntervalMs: PING_INTERVAL_MS,
    pingTimeoutMs: PING_TIMEOUT_MS,
    pingIdleConnection: true,
  });
  const interceptors = [createHeaderInterceptor(options), ...(options.interceptors ?? [])];
  const shared = {
    baseUrl: origin,
    httpVersion: "2" as const,
    sessionManager,
    interceptors,
    jsonOptions: { ignoreUnknownFields: true },
    nodeOptions: options.insecure === true ? { rejectUnauthorized: false } : undefined,
  };
  const jsonTransport = createConnectTransport({ ...shared, useBinaryFormat: false });
  const binaryTransport = createConnectTransport({ ...shared, useBinaryFormat: true });
  const codecMemory = createCodecMemory();
  const transport = createCodecFallbackTransport(jsonTransport, binaryTransport, codecMemory);
  return {
    origin,
    jsonTransport,
    binaryTransport,
    transport,
    sessionManager,
    codecMemory,
    close: () => sessionManager.abort(),
  };
}

export function createServiceClient<Desc extends DescService>(
  service: Desc,
  transport: Transport,
): Client<Desc> {
  return createClient(service, transport);
}

export async function unaryCall<I extends DescMessage, O extends DescMessage>(
  transport: Transport,
  method: DescMethodUnary<I, O>,
  input: MessageInitShape<I>,
  options: { signal?: AbortSignal; headers?: Headers } = {},
): Promise<MessageShape<O>> {
  try {
    if (options.signal?.aborted) {
      throw CancelledError.fromAbort(options.signal.reason);
    }
    const response = await transport.unary(
      method,
      options.signal,
      undefined,
      options.headers,
      input,
    );
    return response.message;
  } catch (error) {
    throw mapTransportError(error);
  }
}

export function mapTransportError(error: unknown): CursorRpcError {
  if (error instanceof CursorRpcError) {
    return error;
  }
  const connect = ConnectError.from(error);
  if (connect.code === Code.Canceled) {
    return CancelledError.fromAbort(connect);
  }
  return CursorRpcError.from(sanitizeError(connect), {
    code: connectCodeName(connect.code),
    isRetryable: isRetryableCode(connect.code),
    requestId: connect.metadata.get("x-request-id") ?? undefined,
  });
}

export function sanitizeError(error: unknown): unknown {
  if (typeof error === "string") {
    return redactUserinfo(error);
  }
  if (error instanceof Error) {
    const copy = new Error(redactUserinfo(error.message));
    copy.name = error.name;
    if (typeof error.stack === "string") {
      copy.stack = redactUserinfo(error.stack);
    }
    if (error.cause !== undefined) {
      copy.cause = sanitizeError(error.cause);
    }
    if (error instanceof ConnectError) {
      return CursorRpcError.from(copy, {
        code: connectCodeName(error.code),
      });
    }
    return copy;
  }
  return error;
}

function redactUserinfo(value: string): string {
  return value.replace(/https?:\/\/[^/@\s]+:[^/@\s]+@/gi, (match) => match.replace(/\/\/[^@]+@/, "//[redacted]@"));
}

function connectCodeName(code: Code): string {
  switch (code) {
    case Code.Canceled:
      return "cancelled";
    case Code.Unknown:
      return "unknown";
    case Code.InvalidArgument:
      return "invalid_argument";
    case Code.DeadlineExceeded:
      return "deadline_exceeded";
    case Code.NotFound:
      return "not_found";
    case Code.AlreadyExists:
      return "already_exists";
    case Code.PermissionDenied:
      return "permission_denied";
    case Code.ResourceExhausted:
      return "resource_exhausted";
    case Code.FailedPrecondition:
      return "failed_precondition";
    case Code.Aborted:
      return "aborted";
    case Code.OutOfRange:
      return "out_of_range";
    case Code.Unimplemented:
      return "unimplemented";
    case Code.Internal:
      return "internal";
    case Code.Unavailable:
      return "unavailable";
    case Code.DataLoss:
      return "data_loss";
    case Code.Unauthenticated:
      return "unauthenticated";
    default:
      return "unknown";
  }
}

function isRetryableCode(code: Code): boolean {
  return code === Code.Unavailable || code === Code.ResourceExhausted || code === Code.DeadlineExceeded;
}
