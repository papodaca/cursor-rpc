import { login } from "cursor-rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cursorAuth, loadStoredAuth } from "../src/auth.ts";
import { plugin as cursorPlugin } from "../src/plugin.ts";

vi.mock("cursor-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cursor-rpc")>();
  return {
    ...actual,
    login: vi.fn(),
  };
});

describe("OpenCode auth hook", () => {
  beforeEach(() => {
    vi.mocked(login).mockReset();
  });

  it("registers Cursor oauth and API-key methods on the plugin", () => {
    const hooks = cursorPlugin();
    expect(hooks.auth.provider).toBe("cursor-rpc");
    expect(hooks.auth.methods.map((method) => method.type)).toEqual(["oauth", "api"]);
    expect(hooks.auth.methods[0]?.label).toBe("Login with Cursor");
  });

  it("polls Cursor login and returns tokens for OpenCode to store", async () => {
    const wait = vi.fn(async () => ({ accessToken: "access-1", refreshToken: "refresh-1" }));
    vi.mocked(login).mockReturnValue({
      url: "https://cursor.com/loginDeepControl?challenge=abc",
      challenge: { uuid: "u", verifier: "v", challenge: "c", url: "https://cursor.com/loginDeepControl?challenge=abc" },
      wait,
    });

    const pending = await cursorAuth().methods[0]!.authorize();
    expect(pending.url).toContain("loginDeepControl");
    expect(pending.method).toBe("auto");
    expect(wait).not.toHaveBeenCalled();

    const result = await pending.callback();
    expect(wait).toHaveBeenCalledOnce();
    expect(result).toEqual({
      type: "success",
      provider: "cursor-rpc",
      access: "access-1",
      refresh: "refresh-1",
      expires: expect.any(Number),
    });
    if (result.type === "success" && "expires" in result) {
      expect(result.expires).toBeGreaterThan(Date.now());
    }
  });

  it("returns failed when Cursor login poll throws and does not start login from the loader", async () => {
    vi.mocked(login).mockReturnValue({
      url: "https://cursor.com/loginDeepControl",
      challenge: { uuid: "u", verifier: "v", challenge: "c", url: "https://cursor.com/loginDeepControl" },
      wait: async () => {
        throw new Error("invalid token, please log in again");
      },
    });

    const pending = await cursorAuth().methods[0]!.authorize();
    await expect(pending.callback()).resolves.toEqual({ type: "failed" });
    expect(await loadStoredAuth(async () => undefined)).toEqual({});
    expect(vi.mocked(login).mock.calls).toHaveLength(1);
  });

  it("loads oauth tokens as createClient credentials and API keys as apiKey", async () => {
    await expect(
      loadStoredAuth(async () => ({ type: "oauth", access: "acc", refresh: "ref" })),
    ).resolves.toEqual({
      credentials: { accessToken: "acc", refreshToken: "ref" },
    });
    await expect(loadStoredAuth(async () => ({ type: "api", key: "key_ok" }))).resolves.toEqual({
      apiKey: "key_ok",
    });
  });

  it("stores a pasted API key through the API method", async () => {
    const method = cursorAuth().methods[1];
    expect(method?.type).toBe("api");
    if (method?.type !== "api") {
      throw new Error("expected api method");
    }
    await expect(method.authorize({ api_key: " key_ok " })).resolves.toEqual({ type: "success", key: "key_ok" });
    await expect(method.authorize({})).resolves.toEqual({ type: "failed" });
  });

  it("stores tokens under the requested provider id", async () => {
    vi.mocked(login).mockReturnValue({
      url: "https://cursor.com/loginDeepControl",
      challenge: { uuid: "u", verifier: "v", challenge: "c", url: "https://cursor.com/loginDeepControl" },
      wait: async () => ({ accessToken: "a", refreshToken: "r" }),
    });
    const pending = await cursorAuth("cursor-rpc").methods[0]!.authorize();
    const result = await pending.callback();
    expect(result).toMatchObject({ type: "success", provider: "cursor-rpc" });
  });
});
