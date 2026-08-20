import { create, type DescMethodUnary } from "@bufbuild/protobuf";
import { Code, ConnectError, createContextValues, type Interceptor, type StreamResponse, type Transport, type UnaryResponse } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { AgentService } from "../src/generated/agent/v1/agent_pb.ts";
import {
  GetServerConfigResponseSchema,
  Http2Config,
  ServerConfigService,
} from "../src/generated/aiserver/v1/server_config_pb.ts";
import { CancelledError } from "../src/errors.ts";
import { createCodecFallbackTransport, createCodecMemory } from "../src/transport/codec.ts";
import { createOriginConnection, mapTransportError, unaryCall } from "../src/transport/connect.ts";
import { DEFAULT_CLIENT_TYPE, applyProtocolHeaders, createHeaderInterceptor } from "../src/transport/headers.ts";

function httpError(status: number, code: Code = Code.Unknown): ConnectError {
  return new ConnectError(`HTTP ${status}`, code);
}

function fakeUnaryTransport(impl: Transport["unary"]): Transport {
  return {
    unary: impl,
    stream: async () => {
      throw new Error("stream not implemented");
    },
  };
}

describe("codec fallback", () => {
  it("retries a JSON unary with binary after HTTP 415", async () => {
    const calls: string[] = [];
    const json = fakeUnaryTransport(async () => {
      calls.push("json");
      throw httpError(415);
    });
    const binary = fakeUnaryTransport(async (method) => {
      calls.push("binary");
      return {
        stream: false,
        service: ServerConfigService,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message: create(GetServerConfigResponseSchema, { http2Config: Http2Config.FORCE_ALL_ENABLED }),
      } as UnaryResponse;
    });
    const memory = createCodecMemory();
    const transport = createCodecFallbackTransport(json, binary, memory);
    const message = await unaryCall(transport, ServerConfigService.method.getServerConfig, {});
    expect(calls).toEqual(["json", "binary"]);
    expect(memory.unary).toBe("binary");
    expect(memory.bidi).toBe("json");
    expect(message.http2Config).toBe(Http2Config.FORCE_ALL_ENABLED);
  });

  it("uses binary only for a later unary after a 415", async () => {
    const calls: string[] = [];
    const json = fakeUnaryTransport(async () => {
      calls.push("json");
      throw httpError(415);
    });
    const binary = fakeUnaryTransport(async (method) => {
      calls.push("binary");
      return {
        stream: false,
        service: ServerConfigService,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message: create(GetServerConfigResponseSchema, { http2Config: Http2Config.FORCE_ALL_ENABLED }),
      } as UnaryResponse;
    });
    const memory = createCodecMemory();
    const transport = createCodecFallbackTransport(json, binary, memory);
    await unaryCall(transport, ServerConfigService.method.getServerConfig, {});
    await unaryCall(transport, ServerConfigService.method.getServerConfig, {});
    expect(calls).toEqual(["json", "binary", "binary"]);
    expect(memory.unary).toBe("binary");
  });

  it("does not retry HTTP 401 as binary", async () => {
    const calls: string[] = [];
    const json = fakeUnaryTransport(async () => {
      calls.push("json");
      throw httpError(401, Code.Unauthenticated);
    });
    const binary = fakeUnaryTransport(async () => {
      calls.push("binary");
      throw new Error("should not be called");
    });
    const transport = createCodecFallbackTransport(json, binary, createCodecMemory());
    await expect(unaryCall(transport, ServerConfigService.method.getServerConfig, {})).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(calls).toEqual(["json"]);
  });

  it("retries a streaming 415 once and does not yield from the failed attempt", async () => {
    const events: string[] = [];
    const json: Transport = {
      unary: async () => {
        throw new Error("unary not used");
      },
      stream: async () => {
        events.push("json-open");
        throw httpError(415);
      },
    };
    const binary: Transport = {
      unary: async () => {
        throw new Error("unary not used");
      },
      stream: async (method) => {
        events.push("binary-open");
        return {
          stream: true,
          service: AgentService,
          method,
          header: new Headers(),
          trailer: new Headers(),
          message: (async function* () {
            events.push("binary-yield");
          })(),
        } as StreamResponse;
      },
    };
    const memory = createCodecMemory();
    const transport = createCodecFallbackTransport(json, binary, memory);
    const response = await transport.stream(
      AgentService.method.run,
      undefined,
      undefined,
      undefined,
      (async function* () {})(),
    );
    expect(events).toEqual(["json-open", "binary-open"]);
    expect(memory.bidi).toBe("binary");
    expect(memory.unary).toBe("json");
    for await (const _ of response.message) {
      /* drain */
    }
    expect(events).toEqual(["json-open", "binary-open", "binary-yield"]);
  });

  it("replays outbound frames consumed by a JSON streaming 415 onto binary", async () => {
    const jsonSeen: number[] = [];
    const binarySeen: number[] = [];
    const json: Transport = {
      unary: async () => {
        throw new Error("unary not used");
      },
      stream: async (_method, _signal, _timeout, _header, input) => {
        for await (const message of input as AsyncIterable<{ n: number }>) {
          jsonSeen.push(message.n);
        }
        throw httpError(415);
      },
    };
    const binary: Transport = {
      unary: async () => {
        throw new Error("unary not used");
      },
      stream: async (method, _signal, _timeout, _header, input) => {
        for await (const message of input as AsyncIterable<{ n: number }>) {
          binarySeen.push(message.n);
        }
        return {
          stream: true,
          service: AgentService,
          method,
          header: new Headers(),
          trailer: new Headers(),
          message: (async function* () {})(),
        } as StreamResponse;
      },
    };
    const memory = createCodecMemory();
    const transport = createCodecFallbackTransport(json, binary, memory);
    const response = await transport.stream(
      AgentService.method.run,
      undefined,
      undefined,
      undefined,
      (async function* () {
        yield { n: 1 };
        yield { n: 2 };
      })(),
    );
    expect(jsonSeen).toEqual([1, 2]);
    expect(binarySeen).toEqual([1, 2]);
    expect(memory.bidi).toBe("binary");
    for await (const _ of response.message) {
      /* drain */
    }
  });
});

describe("headers interceptor", () => {
  it("sets x-ghost-mode true when privacy is unset or the privacy read throws", () => {
    const unset = new Headers();
    applyProtocolHeaders(unset, {}, "GetServerConfig");
    expect(unset.get("x-ghost-mode")).toBe("true");
    expect(unset.get("x-cursor-client-type")).toBe(DEFAULT_CLIENT_TYPE);
    expect(unset.has("authorization")).toBe(false);

    const threw = new Headers();
    applyProtocolHeaders(threw, {
      getGhostMode: () => {
        throw new Error("privacy cache");
      },
    }, "GetServerConfig");
    expect(threw.get("x-ghost-mode")).toBe("true");
  });

  it("omits Authorization when the store is empty and never sends apiKey as Bearer", () => {
    const empty = new Headers();
    applyProtocolHeaders(empty, { getAccessToken: () => undefined, getApiKey: () => "key_live_secret" }, "GetMe");
    expect(empty.has("authorization")).toBe(false);

    const confused = new Headers();
    applyProtocolHeaders(
      confused,
      { getAccessToken: () => "key_live_secret", getApiKey: () => "key_live_secret" },
      "GetMe",
    );
    expect(confused.has("authorization")).toBe(false);

    const ok = new Headers();
    applyProtocolHeaders(ok, { getAccessToken: () => "access_token", getApiKey: () => "key_live_secret" }, "GetMe");
    expect(ok.get("authorization")).toBe("Bearer access_token");
  });

  it("stamps interceptor headers through a Connect interceptor", async () => {
    const seen = new Headers();
    const interceptor = createHeaderInterceptor({ getAccessToken: () => "tok" });
    const next: Parameters<Interceptor> extends [(next: infer N) => infer N] ? N : never = async (req) => {
      req.header.forEach((value, key) => seen.set(key, value));
      return {
        stream: false,
        service: req.service,
        method: req.method as DescMethodUnary,
        header: new Headers(),
        trailer: new Headers(),
        message: req.stream ? undefined : req.message,
      } as UnaryResponse;
    };
    const wrapped = interceptor(next);
    await wrapped({
      stream: false,
      service: ServerConfigService,
      method: ServerConfigService.method.getServerConfig,
      requestMethod: "POST",
      url: "https://api2.cursor.sh/aiserver.v1.ServerConfigService/GetServerConfig",
      signal: new AbortController().signal,
      header: new Headers(),
      contextValues: createContextValues(),
      message: create(ServerConfigService.method.getServerConfig.input),
    });
    expect(seen.get("authorization")).toBe("Bearer tok");
    expect(seen.get("x-ghost-mode")).toBe("true");
    expect(seen.get("x-cursor-client-type")).toBe("private_worker");
    expect(seen.has("x-cursor-checksum")).toBe(false);
  });
});

describe("origin connections", () => {
  it("does not share a session manager across two origins", () => {
    const a = createOriginConnection("https://api2.cursor.sh");
    const b = createOriginConnection("https://agent.example.com");
    expect(a.sessionManager).not.toBe(b.sessionManager);
    expect(a.jsonTransport).not.toBe(a.binaryTransport);
    a.close();
    b.close();
  });
});

describe("transport errors", () => {
  it("cancels a unary with CancelledError", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("This operation was aborted", "AbortError"));
    const transport = fakeUnaryTransport(async () => {
      throw new Error("should not be called");
    });
    await expect(
      unaryCall(transport, ServerConfigService.method.getServerConfig, {}, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it("strips userinfo from a network error that names a proxy URL", () => {
    const error = mapTransportError(new Error("connect failed via https://user:pass@proxy.internal:8080"));
    expect(error.message).not.toContain("user:pass");
    expect(error.message).toContain("[redacted]");
  });
});
