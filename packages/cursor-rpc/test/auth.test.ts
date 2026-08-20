import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { AuthenticationError, CancelledError, PolicyError } from "../src/errors.ts";
import { MemoryCredentialStore } from "../src/credentials.ts";
import { exchangeApiKey } from "../src/auth/api-key.ts";
import { createLoginChallenge, pollLogin } from "../src/auth/login.ts";
import { AuthSession } from "../src/auth/session.ts";
import { isExpiringSoon } from "../src/auth/token.ts";

const API = "https://api2.cursor.sh";

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function jwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("auth", () => {
  it("API key exchange persists access, refresh, and apiKey together", async () => {
    const store = new MemoryCredentialStore();
    const session = new AuthSession({
      apiUrl: API,
      store,
      apiKey: "key_live_secret",
      fetch: async () => jsonResponse(200, { accessToken: jwt(Date.now() / 1000 + 3600), refreshToken: "refresh" }),
    });
    const token = await session.accessToken();
    expect(token).toContain(".");
    expect(store.load()).toMatchObject({
      accessToken: token,
      refreshToken: "refresh",
      apiKey: "key_live_secret",
    });
  });

  it("stores a raw token in both slots and never calls exchange", async () => {
    let calls = 0;
    const store = new MemoryCredentialStore();
    const session = new AuthSession({
      apiUrl: API,
      store,
      authToken: "raw-token",
      apiKey: "key_live_secret",
      fetch: async () => {
        calls += 1;
        return jsonResponse(200, { accessToken: "nope", refreshToken: "nope" });
      },
    });
    await expect(session.accessToken()).resolves.toBe("raw-token");
    expect(calls).toBe(0);
    expect(store.load()).toEqual({ accessToken: "raw-token", refreshToken: "raw-token" });
  });

  it("throws authentication-required without calling login when credentials are missing", async () => {
    const session = new AuthSession({
      apiUrl: API,
      store: new MemoryCredentialStore(),
      env: {},
      fetch: async () => {
        throw new Error("network");
      },
    });
    await expect(session.accessToken()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(session.accessToken()).rejects.toThrow(/authentication required/i);
  });

  it("treats an unparseable JWT as expiring", () => {
    expect(isExpiringSoon("not-a-jwt")).toBe(true);
    expect(isExpiringSoon("a.b.c")).toBe(true);
    expect(isExpiringSoon(jwt(Math.floor(Date.now() / 1000) + 3600))).toBe(false);
  });

  it("maps 403 sign_in_policy_violation to a non-retryable PolicyError", async () => {
    await expect(
      exchangeApiKey(API, "key_live_secret", {
        fetch: async () => jsonResponse(403, { error: "sign_in_policy_violation" }),
      }),
    ).rejects.toBeInstanceOf(PolicyError);
    await expect(
      exchangeApiKey(API, "key_live_secret", {
        fetch: async () => jsonResponse(403, { error: "sign_in_policy_violation" }),
      }),
    ).rejects.toMatchObject({ isRetryable: false });
  });

  it("resets consecutive poll failures on 404 and continues", async () => {
    let polls = 0;
    const challenge = createLoginChallenge({ websiteUrl: "https://cursor.com" });
    const pair = await pollLogin(API, challenge, {
      fetch: async (input) => {
        polls += 1;
        const url = String(input);
        expect(url).not.toContain("Authorization");
        if (polls < 3) {
          return jsonResponse(404, { error: "not found" });
        }
        return jsonResponse(200, { accessToken: "a", refreshToken: "b" });
      },
      sleep: async () => undefined,
    });
    expect(polls).toBe(3);
    expect(pair).toEqual({ accessToken: "a", refreshToken: "b" });
  });

  it("clears the store on Unauthenticated without throwing from clear", () => {
    const store = new MemoryCredentialStore();
    store.save({ accessToken: "tok", refreshToken: "tok" });
    const throwingStore = {
      load: () => store.load(),
      save: (value: { accessToken?: string; refreshToken?: string; apiKey?: string }) => store.save(value),
      clear: () => {
        store.clear();
        throw new Error("clear boom");
      },
    };
    const session = new AuthSession({ apiUrl: API, store: throwingStore, authToken: "tok" });
    expect(() => session.handleAuthFailure(new ConnectError("nope", Code.Unauthenticated), true)).not.toThrow();
    expect(session.pinned).toBe(true);
    expect(store.load()).toBeUndefined();
  });

  it("does not clear the store for Connect internal whose message contains 401", () => {
    const store = new MemoryCredentialStore();
    const session = new AuthSession({ apiUrl: API, store, authToken: "tok" });
    expect(session.handleAuthFailure(new ConnectError("upstream 401", Code.Internal), true)).toBe(false);
    expect(store.load()?.accessToken).toBe("tok");
    expect(session.pinned).toBe(false);
  });

  it("omits API key and poll verifier from public error text", async () => {
    const error = await exchangeApiKey(API, "key_live_secret", {
      fetch: async () => {
        throw new Error("proxy failed for key_live_secret");
      },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(String(error)).not.toContain("key_live_secret");
  });

  it("sends /auth/poll with no Authorization header", async () => {
    const headers: string[] = [];
    const challenge = createLoginChallenge({ websiteUrl: "https://cursor.com" });
    await pollLogin(API, challenge, {
      fetch: async (input, init) => {
        headers.push(new Headers(init?.headers).get("authorization") ?? "");
        expect(String(input)).toContain("/auth/poll");
        return jsonResponse(200, { accessToken: "a", refreshToken: "b" });
      },
    });
    expect(headers).toEqual([""]);
  });

  it("issues no further poll GETs after abort", async () => {
    let polls = 0;
    const controller = new AbortController();
    const challenge = createLoginChallenge({ websiteUrl: "https://cursor.com" });
    const pending = pollLogin(API, challenge, {
      signal: controller.signal,
      fetch: async () => {
        polls += 1;
        controller.abort(new DOMException("This operation was aborted", "AbortError"));
        return jsonResponse(404, {});
      },
      sleep: async (_ms, signal) => {
        if (signal?.aborted) {
          throw CancelledError.fromAbort(signal.reason);
        }
      },
    });
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(polls).toBe(1);
  });

  it("encodes the login challenge from the verifier string, not the raw bytes", () => {
    const bytes = Buffer.alloc(32, 1);
    const login = createLoginChallenge({
      websiteUrl: "https://cursor.com",
      randomBytes: () => bytes,
      uuid: () => "11111111-1111-1111-1111-111111111111",
    });
    expect(login.verifier).toBe("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE");
    expect(login.challenge).toBe("VtX6czP210fbQsI5QH5dpMMvTHnzXQkrE0_TWkAtnFw");
    expect(login.url).toContain("loginDeepControl");
    expect(login.url).toContain("challenge=VtX6czP210fbQsI5QH5dpMMvTHnzXQkrE0_TWkAtnFw");
  });
});
