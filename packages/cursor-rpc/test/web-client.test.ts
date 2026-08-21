import { create, type DescMethodUnary } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport, type UnaryResponse } from "@connectrpc/connect";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AuthenticationError, CancelledError, CursorRpcError } from "../src/errors.ts";
import {
  AiService,
  RunWebFetchResponseSchema,
  RunWebSearchResponseSchema,
} from "../src/generated/aiserver/v1/ai_pb.ts";
import {
  GetDefaultModelForCliResponseSchema,
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/generated/aiserver/v1/models_pb.ts";
import { createWebClient, createWebClientWithTransport } from "../src/web/client.ts";
import { createCodecFallbackTransport, createCodecMemory } from "../src/transport/codec.ts";
import { MemoryCredentialStore } from "../src/credentials.ts";
import * as publicApi from "../src/index.ts";

const MODEL = create(ModelDetailsSchema, { modelId: "composer-2.5", displayName: "Composer" });

function jwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

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

function unaryResponse(method: DescMethodUnary, message: unknown): UnaryResponse {
  return {
    stream: false,
    service: AiService,
    method,
    header: new Headers(),
    trailer: new Headers(),
    message,
  } as UnaryResponse;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createWebClient", () => {
  it("returns fetch content from a mocked unary success", async () => {
    const methods: string[] = [];
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        methods.push(method.name);
        expect(method.name).toBe("RunWebFetch");
        return unaryResponse(
          method,
          create(RunWebFetchResponseSchema, {
            result: { case: "success", value: { content: "# Hello" } },
          }),
        );
      }),
      { authToken: "tok" },
    );
    await expect(client.fetch("https://example.com")).resolves.toEqual({ ok: true, content: "# Hello" });
    expect(methods).toEqual(["RunWebFetch"]);
  });

  it("maps search documents and preserves optional answer", async () => {
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        if (method.name === "GetDefaultModelForCli") {
          return unaryResponse(method, create(GetDefaultModelForCliResponseSchema, { model: MODEL }));
        }
        expect(method.name).toBe("RunWebSearch");
        return unaryResponse(
          method,
          create(RunWebSearchResponseSchema, {
            answer: "summary",
            documents: [{ url: "https://example.com", title: "Example", text: "chunk" }],
          }),
        );
      }),
      { authToken: "tok" },
    );
    await expect(client.search("term")).resolves.toEqual({
      ok: true,
      answer: "summary",
      documents: [{ url: "https://example.com", title: "Example", text: "chunk" }],
    });
  });

  it("retries JSON 415 then succeeds on binary for fetch", async () => {
    const calls: string[] = [];
    const json = fakeUnaryTransport(async () => {
      calls.push("json");
      throw httpError(415);
    });
    const binary = fakeUnaryTransport(async (method) => {
      calls.push("binary");
      return unaryResponse(
        method,
        create(RunWebFetchResponseSchema, {
          result: { case: "success", value: { content: "ok" } },
        }),
      );
    });
    const client = createWebClientWithTransport(
      createCodecFallbackTransport(json, binary, createCodecMemory()),
      { authToken: "tok" },
    );
    await expect(client.fetch("https://example.com")).resolves.toEqual({ ok: true, content: "ok" });
    expect(calls).toEqual(["json", "binary"]);
  });

  it("exchanges the API key once for overlapping fetch and search", async () => {
    let exchanges = 0;
    const gate = Promise.withResolvers<void>();
    let started = 0;
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        if (method.name === "GetDefaultModelForCli") {
          return unaryResponse(method, create(GetDefaultModelForCliResponseSchema, { model: MODEL }));
        }
        started += 1;
        if (started === 1) {
          await gate.promise;
        }
        if (method.name === "RunWebFetch") {
          return unaryResponse(
            method,
            create(RunWebFetchResponseSchema, {
              result: { case: "success", value: { content: "page" } },
            }),
          );
        }
        return unaryResponse(method, create(RunWebSearchResponseSchema, { documents: [] }));
      }),
      {
        apiKey: "key_live_secret",
        store: new MemoryCredentialStore(),
        fetch: async () => {
          exchanges += 1;
          return jsonResponse(200, {
            accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
            refreshToken: "refresh",
          });
        },
      },
    );
    const fetchPromise = client.fetch("https://example.com");
    const searchPromise = client.search("term");
    await Promise.resolve();
    gate.resolve();
    await expect(fetchPromise).resolves.toMatchObject({ ok: true });
    await expect(searchPromise).resolves.toMatchObject({ ok: true });
    expect(exchanges).toBe(1);
  });

  it("loads default model id once for overlapping first searches", async () => {
    let defaults = 0;
    let usables = 0;
    const gate = Promise.withResolvers<void>();
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method, _signal, _timeout, _headers, input) => {
        if (method.name === "GetDefaultModelForCli") {
          defaults += 1;
          await gate.promise;
          return unaryResponse(method, create(GetDefaultModelForCliResponseSchema, { model: MODEL }));
        }
        if (method.name === "GetUsableModels") {
          usables += 1;
          return unaryResponse(method, create(GetUsableModelsResponseSchema, { models: [MODEL] }));
        }
        expect(method.name).toBe("RunWebSearch");
        expect((input as { modelId?: string }).modelId).toBe("composer-2.5");
        return unaryResponse(method, create(RunWebSearchResponseSchema, { documents: [] }));
      }),
      { authToken: "tok" },
    );
    const first = client.search("a");
    const second = client.search("b");
    await Promise.resolve();
    gate.resolve();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(defaults).toBe(1);
    expect(usables).toBe(0);
  });

  it("throws No model found before RunWebSearch when catalogue ids are empty", async () => {
    const methods: string[] = [];
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        methods.push(method.name);
        if (method.name === "GetDefaultModelForCli") {
          return unaryResponse(method, create(GetDefaultModelForCliResponseSchema, {}));
        }
        if (method.name === "GetUsableModels") {
          return unaryResponse(method, create(GetUsableModelsResponseSchema, { models: [] }));
        }
        throw new Error(`unexpected ${method.name}`);
      }),
      { authToken: "tok" },
    );
    await expect(client.search("term")).rejects.toThrow(/No model found/);
    expect(methods).toEqual(["GetDefaultModelForCli", "GetUsableModels"]);
  });

  it("retries catalogue after a failed first resolve", async () => {
    let defaults = 0;
    let usables = 0;
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        if (method.name === "GetDefaultModelForCli") {
          defaults += 1;
          if (defaults === 1) {
            throw new ConnectError("catalogue down", Code.Internal);
          }
          return unaryResponse(method, create(GetDefaultModelForCliResponseSchema, { model: MODEL }));
        }
        if (method.name === "GetUsableModels") {
          usables += 1;
          throw new ConnectError("catalogue down", Code.Internal);
        }
        expect(method.name).toBe("RunWebSearch");
        return unaryResponse(method, create(RunWebSearchResponseSchema, { documents: [] }));
      }),
      { authToken: "tok" },
    );
    await expect(client.search("term")).rejects.toMatchObject({ code: "internal" });
    await expect(client.search("term")).resolves.toMatchObject({ ok: true });
    expect(defaults).toBe(2);
    expect(usables).toBe(1);
  });

  it("falls back to usable models when GetDefaultModelForCli throws internal", async () => {
    const methods: string[] = [];
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method, _signal, _timeout, _headers, input) => {
        methods.push(method.name);
        if (method.name === "GetDefaultModelForCli") {
          throw new ConnectError("boom", Code.Internal);
        }
        if (method.name === "GetUsableModels") {
          return unaryResponse(method, create(GetUsableModelsResponseSchema, { models: [MODEL] }));
        }
        expect(method.name).toBe("RunWebSearch");
        expect((input as { modelId?: string }).modelId).toBe("composer-2.5");
        return unaryResponse(method, create(RunWebSearchResponseSchema, { documents: [] }));
      }),
      { authToken: "tok" },
    );
    await expect(client.search("term")).resolves.toMatchObject({ ok: true });
    expect(methods).toEqual(["GetDefaultModelForCli", "GetUsableModels", "RunWebSearch"]);
  });

  it("uses first usable model when default id is whitespace", async () => {
    const methods: string[] = [];
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method, _signal, _timeout, _headers, input) => {
        methods.push(method.name);
        if (method.name === "GetDefaultModelForCli") {
          return unaryResponse(
            method,
            create(GetDefaultModelForCliResponseSchema, {
              model: create(ModelDetailsSchema, { modelId: "   ", displayName: "Blank" }),
            }),
          );
        }
        if (method.name === "GetUsableModels") {
          return unaryResponse(method, create(GetUsableModelsResponseSchema, { models: [MODEL] }));
        }
        expect(method.name).toBe("RunWebSearch");
        expect((input as { modelId?: string }).modelId).toBe("composer-2.5");
        return unaryResponse(method, create(RunWebSearchResponseSchema, { documents: [] }));
      }),
      { authToken: "tok" },
    );
    await expect(client.search("term")).resolves.toMatchObject({ ok: true });
    expect(methods).toEqual(["GetDefaultModelForCli", "GetUsableModels", "RunWebSearch"]);
  });

  it("does not call model rpcs for fetch", async () => {
    const methods: string[] = [];
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        methods.push(method.name);
        return unaryResponse(
          method,
          create(RunWebFetchResponseSchema, {
            result: { case: "success", value: { content: "x" } },
          }),
        );
      }),
      { authToken: "tok" },
    );
    await client.fetch("https://example.com");
    expect(methods).toEqual(["RunWebFetch"]);
  });

  it("aborting one call does not fail the sibling unary or close the client", async () => {
    const fetchAbort = new AbortController();
    const searchGate = Promise.withResolvers<void>();
    let searchStarted = false;
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method, signal) => {
        if (method.name === "GetDefaultModelForCli") {
          return unaryResponse(method, create(GetDefaultModelForCliResponseSchema, { model: MODEL }));
        }
        if (method.name === "RunWebFetch") {
          fetchAbort.abort();
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (signal?.aborted) {
            throw new ConnectError("cancelled", Code.Canceled);
          }
          return unaryResponse(
            method,
            create(RunWebFetchResponseSchema, {
              result: { case: "success", value: { content: "late" } },
            }),
          );
        }
        searchStarted = true;
        await searchGate.promise;
        return unaryResponse(method, create(RunWebSearchResponseSchema, { documents: [] }));
      }),
      { authToken: "tok" },
    );
    const fetchPromise = client.fetch("https://example.com", { signal: fetchAbort.signal });
    const searchPromise = client.search("term");
    await Promise.resolve();
    searchGate.resolve();
    await expect(fetchPromise).rejects.toBeInstanceOf(CancelledError);
    await expect(searchPromise).resolves.toMatchObject({ ok: true, documents: [] });
    expect(searchStarted).toBe(true);
    await expect(client.fetch("https://example.com/other")).resolves.toMatchObject({ ok: true });
  });

  it("aborting one search during GetDefaultModelForCli does not fail the sibling", async () => {
    const abort = new AbortController();
    const gate = Promise.withResolvers<void>();
    let defaults = 0;
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        if (method.name === "GetDefaultModelForCli") {
          defaults += 1;
          abort.abort();
          await gate.promise;
          return unaryResponse(method, create(GetDefaultModelForCliResponseSchema, { model: MODEL }));
        }
        expect(method.name).toBe("RunWebSearch");
        return unaryResponse(method, create(RunWebSearchResponseSchema, { documents: [] }));
      }),
      { authToken: "tok" },
    );
    const first = client.search("a", { signal: abort.signal });
    const second = client.search("b");
    await expect(first).rejects.toBeInstanceOf(CancelledError);
    gate.resolve();
    await expect(second).resolves.toMatchObject({ ok: true, documents: [] });
    expect(defaults).toBe(1);
  });

  it("aborting one waiter during token exchange does not cancel the sibling", async () => {
    const abort = new AbortController();
    const gate = Promise.withResolvers<void>();
    let exchanges = 0;
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        if (method.name === "GetDefaultModelForCli") {
          return unaryResponse(method, create(GetDefaultModelForCliResponseSchema, { model: MODEL }));
        }
        if (method.name === "RunWebFetch") {
          return unaryResponse(
            method,
            create(RunWebFetchResponseSchema, {
              result: { case: "success", value: { content: "page" } },
            }),
          );
        }
        return unaryResponse(method, create(RunWebSearchResponseSchema, { documents: [] }));
      }),
      {
        apiKey: "key_live_secret",
        store: new MemoryCredentialStore(),
        fetch: async () => {
          exchanges += 1;
          abort.abort();
          await gate.promise;
          return jsonResponse(200, {
            accessToken: jwt(Math.floor(Date.now() / 1000) + 3600),
            refreshToken: "refresh",
          });
        },
      },
    );
    const fetchPromise = client.fetch("https://example.com", { signal: abort.signal });
    const searchPromise = client.search("term");
    await expect(fetchPromise).rejects.toBeInstanceOf(CancelledError);
    gate.resolve();
    await expect(searchPromise).resolves.toMatchObject({ ok: true });
    expect(exchanges).toBe(1);
  });

  it("throws AuthenticationError before network when credentials are missing", async () => {
    let unary = 0;
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async () => {
        unary += 1;
        throw new Error("network");
      }),
      { env: {} },
    );
    await expect(client.fetch("https://example.com")).rejects.toBeInstanceOf(AuthenticationError);
    expect(unary).toBe(0);
  });

  it("throws CancelledError when abort fires during the unary", async () => {
    const abort = new AbortController();
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (_method, signal) => {
        abort.abort();
        if (signal?.aborted) {
          throw new ConnectError("cancelled", Code.Canceled);
        }
        throw new Error("should abort");
      }),
      { authToken: "tok" },
    );
    await expect(client.fetch("https://example.com", { signal: abort.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it("pins after Unauthenticated and does not re-exchange on the next search", async () => {
    let exchanges = 0;
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        if (method.name === "RunWebFetch") {
          throw new ConnectError("expired", Code.Unauthenticated);
        }
        throw new Error(`unexpected ${method.name}`);
      }),
      {
        apiKey: "key_live_secret",
        store: new MemoryCredentialStore(),
        fetch: async () => {
          exchanges += 1;
          return jsonResponse(200, { accessToken: "access", refreshToken: "refresh" });
        },
      },
    );
    await expect(client.fetch("https://example.com")).rejects.toBeInstanceOf(AuthenticationError);
    expect(exchanges).toBe(1);
    await expect(client.search("term")).rejects.toBeInstanceOf(AuthenticationError);
    expect(exchanges).toBe(1);
  });

  it("pins after Unauthenticated overlapping a second accessToken refresh and does not complete search", async () => {
    let exchanges = 0;
    const fetchEntered = Promise.withResolvers<void>();
    const fetchGate = Promise.withResolvers<void>();
    const secondExchangeStarted = Promise.withResolvers<void>();
    const secondExchangeGate = Promise.withResolvers<void>();
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) => {
        if (method.name === "RunWebFetch") {
          fetchEntered.resolve();
          await fetchGate.promise;
          throw new ConnectError("expired", Code.Unauthenticated);
        }
        if (method.name === "GetDefaultModelForCli") {
          return unaryResponse(method, create(GetDefaultModelForCliResponseSchema, { model: MODEL }));
        }
        if (method.name === "RunWebSearch") {
          return unaryResponse(method, create(RunWebSearchResponseSchema, { documents: [] }));
        }
        throw new Error(`unexpected ${method.name}`);
      }),
      {
        apiKey: "key_live_secret",
        store: new MemoryCredentialStore(),
        fetch: async () => {
          exchanges += 1;
          if (exchanges === 1) {
            return jsonResponse(200, { accessToken: "access", refreshToken: "refresh" });
          }
          secondExchangeStarted.resolve();
          await secondExchangeGate.promise;
          return jsonResponse(200, { accessToken: "access2", refreshToken: "refresh2" });
        },
      },
    );
    const fetchPromise = client.fetch("https://example.com");
    await fetchEntered.promise;
    const searchPromise = client.search("term");
    await secondExchangeStarted.promise;
    fetchGate.resolve();
    await expect(fetchPromise).rejects.toBeInstanceOf(AuthenticationError);
    secondExchangeGate.resolve();
    await expect(searchPromise).rejects.toBeInstanceOf(AuthenticationError);
    expect(exchanges).toBe(2);
    await expect(client.search("later")).rejects.toBeInstanceOf(AuthenticationError);
    expect(exchanges).toBe(2);
  });

  it("throws unimplemented without fetching the url or closing the client", async () => {
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse(200, {});
    }) as typeof fetch;
    try {
      const client = createWebClientWithTransport(
        fakeUnaryTransport(async () => {
          throw new ConnectError("nope", Code.Unimplemented);
        }),
        { authToken: "tok" },
      );
      await expect(client.fetch("https://example.com/secret")).rejects.toMatchObject({ code: "unimplemented" });
      expect(urls).toEqual([]);
      await expect(client.fetch("https://example.com/secret")).rejects.toMatchObject({ code: "unimplemented" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("redacts Bearer and URL userinfo in message, toJSON, and inspect", async () => {
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async () => {
        throw new ConnectError("Bearer secret-token from https://user:pass@example.com/path", Code.Internal);
      }),
      { authToken: "tok" },
    );
    const error = await client.fetch("https://example.com").then(
      () => {
        throw new Error("expected throw");
      },
      (value) => value,
    );
    expect(error).toBeInstanceOf(CursorRpcError);
    expect(error.message).not.toMatch(/secret-token/);
    expect(error.message).not.toMatch(/user:pass/);
    expect(error.toJSON().message).not.toMatch(/secret-token/);
    expect(inspect(error)).not.toMatch(/secret-token/);
    expect(inspect(error)).not.toMatch(/user:pass/);
  });

  it("fail-closes after close and treats a second close as safe", async () => {
    const client = createWebClientWithTransport(
      fakeUnaryTransport(async (method) =>
        unaryResponse(
          method,
          create(RunWebFetchResponseSchema, {
            result: { case: "success", value: { content: "ok" } },
          }),
        ),
      ),
      { authToken: "tok" },
    );
    client.close();
    client.close();
    await expect(client.fetch("https://example.com")).rejects.toBeInstanceOf(CursorRpcError);
  });

  it("exports createWebClient from the package index without proto internals", () => {
    expect(typeof publicApi.createWebClient).toBe("function");
    expect(publicApi).not.toHaveProperty("AiService");
    expect(publicApi).not.toHaveProperty("AuthSession");
    expect(publicApi).not.toHaveProperty("createOriginConnection");
    expect(publicApi).not.toHaveProperty("createWebClientWithTransport");
  });

  it("constructs without credentials so a later execute can fail", () => {
    const client = createWebClient({ env: {} });
    expect(typeof client.fetch).toBe("function");
    expect(typeof client.search).toBe("function");
    expect(typeof client.close).toBe("function");
  });
});
