import { inspect } from "node:util";
import { APICallError } from "@ai-sdk/provider";
import { createClient, type CursorRpcClient, type RunHandle } from "cursor-rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCursor } from "../src/index.ts";

vi.mock("cursor-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cursor-rpc")>();
  return {
    ...actual,
    createClient: vi.fn((options: Parameters<typeof actual.createClient>[0]) => actual.createClient(options)),
  };
});

const SECRET_NAMES =
  /apiKey|Bearer |CURSOR_API_KEY|CURSOR_AUTH_TOKEN|accessToken|refreshToken/;

function failingFetch(): typeof fetch {
  return async () => {
    throw new Error("fetch must not be called");
  };
}

function fakeCompletingClient(): CursorRpcClient {
  const handle = (): RunHandle => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", text: "ok" };
      yield { type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    wait: async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, events: [] }),
    abort: () => undefined,
    conversationHistory: () => ({ messages: [] }) as ReturnType<RunHandle["conversationHistory"]>,
  });
  return {
    close: () => undefined,
    run: async () => handle(),
    models: async () => ({ models: [], aliasMap: new Map() }),
  };
}

function assertNoSecrets(value: unknown): void {
  const text = inspect(value, { depth: 8, getters: true });
  expect(text).not.toMatch(SECRET_NAMES);
}

describe("createCursor factory", () => {
  beforeEach(() => {
    vi.mocked(createClient).mockReset();
  });

  it("exports createCursor as the only create* function", async () => {
    const mod = await import("../src/index.ts");
    expect(typeof mod.createCursor).toBe("function");
    const createKeys = Object.keys(mod).filter((key) => key.startsWith("create"));
    expect(createKeys[0]).toBe("createCursor");
    expect(createKeys).toEqual(["createCursor"]);
    expect(Object.keys(mod)).toEqual(["createCursor"]);
  });

  it("returns a v3 language model from createCursor({}).languageModel", () => {
    const model = createCursor({}).languageModel("x");
    expect(model.specificationVersion).toBe("v3");
  });

  it("fails closed without fetch when credentials are missing", async () => {
    const fetch = vi.fn(failingFetch());
    const model = createCursor({ env: {}, fetch }).languageModel("x");
    await expect(model.doGenerate({ prompt: [] })).rejects.toBeInstanceOf(APICallError);
    await expect(model.doStream({ prompt: [] })).rejects.toBeInstanceOf(APICallError);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(createClient)).toHaveBeenCalled();
    const error = await model.doGenerate({ prompt: [] }).catch((caught: unknown) => caught);
    assertNoSecrets(error);
    expect(String(error)).not.toContain("CURSOR_API_KEY");
  });

  it("does not leak credential names or values from generate or stream results", async () => {
    const apiKey = "key_leaky_factory_secret";
    const fetch = vi.fn(failingFetch());
    vi.mocked(createClient).mockImplementation(() => fakeCompletingClient());
    const model = createCursor({
      apiKey,
      env: {},
      fetch,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Cookie: "session=leaked",
      },
    }).languageModel("x");
    const generated = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const streamed = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    const parts: unknown[] = [];
    for await (const part of streamed.stream) {
      parts.push(part);
    }
    expect(generated.content).toEqual(expect.arrayContaining([{ type: "text", text: "ok" }]));
    expect(
      parts.some((part) => typeof part === "object" && part !== null && "type" in part && part.type === "finish"),
    ).toBe(true);
    assertNoSecrets(generated);
    assertNoSecrets(parts);
    expect(inspect(generated)).not.toContain(apiKey);
    expect(inspect(parts)).not.toContain(apiKey);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards name, apiKey, and fetch; sanitizes headers; omits abortSignal", async () => {
    const fetch = failingFetch();
    const abortSignal = AbortSignal.abort();
    const provider = createCursor({
      name: "cursor",
      apiKey: "key_ok",
      fetch,
      abortSignal,
      env: {},
      headers: {
        Authorization: "Bearer secret-token",
        Cookie: "a=b",
        "x-api-key": "hidden",
        x_api_key: "hidden",
        "x-auth-token": "hidden",
        "x-secret": "hidden",
        "set-cookie": "session=leaked",
        "x-request-id": "keep-me",
      },
    });
    const model = provider.languageModel("composer");
    expect(model.provider).toBe("cursor");
    expect(model.modelId).toBe("composer");
    await model.doGenerate({ prompt: [] }).catch(() => undefined);

    expect(vi.mocked(createClient)).toHaveBeenCalled();
    const options = vi.mocked(createClient).mock.lastCall?.[0];
    expect(options).toBeDefined();
    expect(options?.apiKey).toBe("key_ok");
    expect(options?.fetch).toBe(fetch);
    expect(options?.clientType).toBe("cli");
    expect(options?.clientVersion).toBe("cli-1.0.0");
    expect(options?.signal).toBeUndefined();
    expect(options).not.toHaveProperty("abortSignal");

    const headers = options?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect(headers?.get("authorization")).toBeNull();
    expect(headers?.get("cookie")).toBeNull();
    expect(headers?.get("x-api-key")).toBeNull();
    expect(headers?.get("x-api_key")).toBeNull();
    expect(headers?.get("x-auth-token")).toBeNull();
    expect(headers?.get("x-secret")).toBeNull();
    expect(headers?.get("set-cookie")).toBeNull();
    expect(headers?.get("x-request-id")).toBe("keep-me");
  });

  it("forwards only credential env keys to createClient", async () => {
    const fetch = failingFetch();
    const provider = createCursor({
      apiKey: "key_ok",
      fetch,
      env: {
        CURSOR_API_KEY: "key_from_env",
        CURSOR_AUTH_TOKEN: "token_from_env",
        CURSOR_API_ENDPOINT: "https://evil.example/steal",
        PATH: "/tmp",
      },
    });
    await provider.languageModel("composer").doGenerate({ prompt: [] }).catch(() => undefined);
    const options = vi.mocked(createClient).mock.lastCall?.[0];
    expect(options?.env).toEqual({
      CURSOR_API_KEY: "key_from_env",
      CURSOR_AUTH_TOKEN: "token_from_env",
    });
  });

  it("constructs one client per factory and close() disposes without an abort signal", async () => {
    const fetch = failingFetch();
    const provider = createCursor({ apiKey: "key_ok", env: {}, fetch });
    expect(provider.close.length).toBe(0);
    await provider.languageModel("a").doGenerate({ prompt: [] }).catch(() => undefined);
    await provider.languageModel("b").doStream({ prompt: [] }).catch(() => undefined);
    const callsAfterModels = vi.mocked(createClient).mock.calls.length;
    await provider.languageModel("c").doGenerate({ prompt: [] }).catch(() => undefined);
    expect(vi.mocked(createClient).mock.calls.length).toBe(callsAfterModels);
    provider.close();
    await provider.languageModel("d").doGenerate({ prompt: [] }).catch(() => undefined);
    expect(vi.mocked(createClient).mock.calls.length).toBe(callsAfterModels + 1);
  });
});
