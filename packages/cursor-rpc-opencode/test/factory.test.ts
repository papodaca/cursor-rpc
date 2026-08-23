import { inspect } from "node:util";
import { AuthenticationError, createClient } from "cursor-rpc";
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

function assertNoSecrets(value: unknown): void {
  const text = inspect(value, { depth: 8, getters: true });
  expect(text).not.toMatch(SECRET_NAMES);
}

describe("createCursor factory", () => {
  beforeEach(() => {
    vi.mocked(createClient).mockClear();
  });

  it("exports createCursor as the only create* function", async () => {
    const mod = await import("../src/index.ts");
    expect(typeof mod.createCursor).toBe("function");
    const createKeys = Object.keys(mod).filter((key) => key.startsWith("create"));
    expect(createKeys[0]).toBe("createCursor");
    expect(createKeys).toEqual(["createCursor"]);
  });

  it("returns a v3 language model from createCursor({}).languageModel", () => {
    const model = createCursor({}).languageModel("x");
    expect(model.specificationVersion).toBe("v3");
  });

  it("throws AuthenticationError without fetch when credentials are missing", async () => {
    const fetch = vi.fn(failingFetch());
    const model = createCursor({ env: {}, fetch }).languageModel("x");
    await expect(model.doGenerate({ prompt: [] })).rejects.toBeInstanceOf(AuthenticationError);
    await expect(model.doStream({ prompt: [] })).rejects.toBeInstanceOf(AuthenticationError);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(createClient)).toHaveBeenCalled();
    const error = await model.doGenerate({ prompt: [] }).catch((caught: unknown) => caught);
    assertNoSecrets(error);
    expect(String(error)).not.toContain("CURSOR_API_KEY");
  });

  it("does not leak credential names or values from not-implemented generate errors", async () => {
    const apiKey = "key_leaky_factory_secret";
    const fetch = vi.fn(failingFetch());
    const model = createCursor({
      apiKey,
      env: {},
      fetch,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Cookie: "session=leaked",
      },
    }).languageModel("x");
    const generateError = await model.doGenerate({ prompt: [] }).catch((caught: unknown) => caught);
    const streamError = await model.doStream({ prompt: [] }).catch((caught: unknown) => caught);
    expect(generateError).toBeInstanceOf(Error);
    expect(streamError).toBeInstanceOf(Error);
    expect(String(generateError)).toMatch(/not implemented/i);
    expect(String(streamError)).toMatch(/not implemented/i);
    assertNoSecrets(generateError);
    assertNoSecrets(streamError);
    expect(inspect(generateError)).not.toContain(apiKey);
    expect(inspect(streamError)).not.toContain(apiKey);
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
        "x-auth-token": "hidden",
        "x-secret": "hidden",
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
    expect(options?.signal).toBeUndefined();
    expect(options).not.toHaveProperty("abortSignal");

    const headers = options?.headers;
    expect(headers).toBeInstanceOf(Headers);
    expect(headers?.get("authorization")).toBeNull();
    expect(headers?.get("cookie")).toBeNull();
    expect(headers?.get("x-api-key")).toBeNull();
    expect(headers?.get("x-auth-token")).toBeNull();
    expect(headers?.get("x-secret")).toBeNull();
    expect(headers?.get("x-request-id")).toBe("keep-me");
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
