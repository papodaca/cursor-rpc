import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "cursor-rpc";
import { ClientEpoch, cursorAuth, dropAfterAuthError, pluginRuntimeEnv, resolveClientSecret } from "../src/auth.ts";
import { streamCursor } from "../src/stream.ts";
import { asTestStream, fakeEpoch, isolatedHome, TEST_MODEL, waitForStream } from "./helpers.ts";

const originalHome = process.env.HOME;
const originalKey = process.env.CURSOR_API_KEY;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalKey === undefined) {
    delete process.env.CURSOR_API_KEY;
  } else {
    process.env.CURSOR_API_KEY = originalKey;
  }
});

describe("auth adapter", () => {
  it("headless env key resolves as apiKey and not a JWT authToken", () => {
    const secret = resolveClientSecret({ apiKey: undefined }, { CURSOR_API_KEY: "key_live_test" });
    expect(secret).toEqual({ apiKey: "key_live_test" });
  });

  it("oauth JWT uses authToken", () => {
    const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig";
    expect(resolveClientSecret({ apiKey: jwt }, {})).toEqual({ authToken: jwt });
  });

  it("streamSimple with env key never calls login", async () => {
    process.env.CURSOR_API_KEY = "key_live_test";
    const loginFn = vi.fn(() => {
      throw new Error("login must not run");
    });
    const { epoch } = fakeEpoch({ events: [{ type: "text_delta", text: "ok" }, { type: "turn_ended", usage: {} }] });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }),
    );
    await waitForStream(stream);
    expect(loginFn).not.toHaveBeenCalled();
    expect(stream.events.some((event) => event.type === "done")).toBe(true);
    await expect(cursorAuth({ login: loginFn as never }).apiKey.resolve({})).resolves.toMatchObject({
      source: "CURSOR_API_KEY",
    });
  });

  it("plugin runtime env omits CURSOR_AUTH_TOKEN and CURSOR_API_KEY", () => {
    const env = pluginRuntimeEnv({
      CURSOR_AUTH_TOKEN: "cli-jwt",
      CURSOR_API_KEY: "key_live_test",
      CURSOR_API_ENDPOINT: "https://example.invalid",
    });
    expect(env.CURSOR_AUTH_TOKEN).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_ENDPOINT).toBe("https://example.invalid");
  });

  it("/login helper returns an authorization URL without poll verifier and stores access JWT", async () => {
    const jwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig";
    const urls: string[] = [];
    const auth = cursorAuth({
      login: () => ({
        url: "https://cursor.com/loginDeepControl?challenge=abc&uuid=1&mode=login",
        challenge: { uuid: "1", verifier: "poll-verifier-secret", challenge: "abc", url: "unused" },
        wait: async () => ({ accessToken: jwt, refreshToken: "refresh" }),
      }),
    });
    const credentials = await auth.oauth.login({
      onAuth: ({ url }) => {
        urls.push(url);
      },
    });
    expect(urls[0]).toContain("challenge=");
    expect(urls[0]).not.toContain("verifier=");
    expect(credentials.access).toBe(jwt);
    expect(JSON.stringify(credentials)).not.toContain("poll-verifier-secret");
    expect(JSON.stringify(credentials)).not.toContain("verifier=");
    expect(auth.oauth.getApiKey(credentials)).toBe(jwt);
  });

  it("missing credentials from streamSimple emit error and do not poll", async () => {
    delete process.env.CURSOR_API_KEY;
    const loginFn = vi.fn();
    cursorAuth({ login: loginFn as never });
    const stream = asTestStream(streamCursor(new ClientEpoch(), TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }));
    await waitForStream(stream);
    const error = stream.events.find((event) => event.type === "error");
    expect(error?.type === "error" ? error.error.stopReason : undefined).toBe("error");
    expect(loginFn).not.toHaveBeenCalled();
  });

  it("AuthenticationError drops the pinned Client; 401 substring errors do not", async () => {
    process.env.CURSOR_API_KEY = "key_live_test";
    const { epoch, clients } = fakeEpoch({
      error: new AuthenticationError("expired"),
    });
    const first = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }, { apiKey: "key_live_test" }),
    );
    await waitForStream(first);
    expect(clients).toHaveLength(1);

    const { epoch: stallEpoch, clients: stallClients } = fakeEpoch({
      error: new Error("rate limit 401 unauthorized"),
    });
    const stall = asTestStream(
      streamCursor(stallEpoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }, { apiKey: "key_live_test" }),
    );
    await waitForStream(stall);
    dropAfterAuthError(stallEpoch, new Error("rate limit 401 unauthorized"));
    stallEpoch.clientFor({ apiKey: "key_live_test" });
    expect(stallClients).toHaveLength(1);

    const reused = epoch.clientFor({ apiKey: "key_live_test" });
    expect(clients).toHaveLength(2);
    expect(reused).not.toBe(clients[0]);
  });

  it("does not harvest ~/.cursor/auth.json even when it exists", async () => {
    const home = isolatedHome();
    process.env.HOME = home;
    delete process.env.CURSOR_API_KEY;
    const before = readFileSync(join(home, ".cursor", "auth.json"), "utf8");
    const stream = asTestStream(streamCursor(new ClientEpoch(), TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }));
    await waitForStream(stream);
    expect(readFileSync(join(home, ".cursor", "auth.json"), "utf8")).toBe(before);
    expect(existsSync(join(home, ".cursor", "auth.json"))).toBe(true);
    const error = stream.events.find((event) => event.type === "error");
    expect(error?.type === "error" ? error.error.errorMessage : undefined).toContain("authentication required");
  });

  it("login failure redacts verifier and Bearer from the Pi-facing error", async () => {
    const auth = cursorAuth({
      login: () => ({
        url: "https://cursor.com/loginDeepControl?challenge=abc&uuid=1&mode=login",
        challenge: { uuid: "1", verifier: "secret", challenge: "abc", url: "unused" },
        wait: async () => {
          throw new Error("poll failed verifier=secret Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig");
        },
      }),
    });
    await expect(
      auth.oauth.login({
        onAuth: ({ url }) => {
          expect(url).not.toContain("verifier=");
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes("verifier=") && !message.includes("Bearer ");
    });
  });
});
