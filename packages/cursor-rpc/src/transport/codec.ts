import { Code, ConnectError, type Transport } from "@connectrpc/connect";

export type CodecKind = "json" | "binary";
export type RpcKind = "unary" | "bidi";

export type CodecMemory = {
  unary: CodecKind;
  bidi: CodecKind;
};

export function createCodecMemory(): CodecMemory {
  return { unary: "json", bidi: "json" };
}

export function isUnsupportedMediaType(error: unknown): boolean {
  const connect = ConnectError.from(error);
  if (connect.code !== Code.Unknown) {
    return false;
  }
  return /\bHTTP 415\b/.test(connect.rawMessage) || /\bHTTP 415\b/.test(connect.message);
}

export function createCodecFallbackTransport(
  jsonTransport: Transport,
  binaryTransport: Transport,
  memory: CodecMemory,
): Transport {
  return {
    async unary(method, signal, timeoutMs, header, input, contextValues) {
      return await invokeWithFallback(
        "unary",
        memory,
        jsonTransport,
        binaryTransport,
        (transport) => transport.unary(method, signal, timeoutMs, header, input, contextValues),
      );
    },
    async stream(method, signal, timeoutMs, header, input, contextValues) {
      return await invokeWithFallback(
        "bidi",
        memory,
        jsonTransport,
        binaryTransport,
        (transport) => transport.stream(method, signal, timeoutMs, header, input, contextValues),
      );
    },
  };
}

async function invokeWithFallback<T>(
  kind: RpcKind,
  memory: CodecMemory,
  jsonTransport: Transport,
  binaryTransport: Transport,
  invoke: (transport: Transport) => Promise<T>,
): Promise<T> {
  const preferred = memory[kind] === "binary" ? binaryTransport : jsonTransport;
  try {
    return await invoke(preferred);
  } catch (error) {
    if (memory[kind] === "binary" || !isUnsupportedMediaType(error)) {
      throw error;
    }
    memory[kind] = "binary";
    return await invoke(binaryTransport);
  }
}
