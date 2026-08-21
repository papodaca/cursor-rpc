import { readFileSync } from "node:fs";
import { Server } from "node:net";
import { fileURLToPath } from "node:url";
import { CancelledError, type RunHandle } from "cursor-rpc";
import OpenAI, { AuthenticationError, BadRequestError, NotFoundError } from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.ts";
import type { StartedServer } from "../src/server.ts";
import { fakeProvider, INBOUND_KEY, startTestServer, thinkingThenHi } from "./helpers.ts";

const DEFAULT_BASE_URL = "http://127.0.0.1:8787/v1";
const servers: StartedServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function start(provider = fakeProvider({ events: thinkingThenHi() })) {
  const started = await startTestServer(provider);
  servers.push(started);
  return started;
}

function sdk(url: string, apiKey = INBOUND_KEY) {
  return new OpenAI({
    apiKey,
    baseURL: `${url}/v1`,
    maxRetries: 0,
  });
}

describe("official OpenAI SDK contract", () => {
  it("lists, retrieves, creates, and streams against an ephemeral listener", async () => {
    const { url } = await start();
    const client = sdk(url);

    const list = await client.models.list();
    const ids = list.data.map((model) => model.id);
    expect(ids).toContain("composer-2");

    const retrieved = await client.models.retrieve("composer-2");
    expect(retrieved.id).toBe("composer-2");

    const completion = await client.chat.completions.create({
      model: "composer-2",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(completion.object).toBe("chat.completion");
    expect(completion.choices[0]?.message.content).toBe("hi");

    const stream = await client.chat.completions.create({
      model: "composer-2",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    let streamed = "";
    for await (const chunk of stream) {
      streamed += chunk.choices[0]?.delta.content ?? "";
    }
    expect(streamed).toBe("hi");
  });

  it("maps tools to BadRequestError, a wrong key to AuthenticationError, and an unknown model to NotFoundError", async () => {
    const { url } = await start();
    const client = sdk(url);

    await expect(
      client.chat.completions.create({
        model: "composer-2",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "x", parameters: { type: "object" } } }],
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    await expect(sdk(url, "sk-wrong").models.list()).rejects.toBeInstanceOf(AuthenticationError);

    await expect(client.models.retrieve("nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      client.chat.completions.create({
        model: "nope",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("includes a terminal data: [DONE] line on a raw fetch stream", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${INBOUND_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    });
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    const text = await response.text();
    expect(text).toContain("data: [DONE]");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("aborts an in-flight SDK stream", async () => {
    const aborted = { value: false };
    const { url } = await start(
      fakeProvider({
        run: async () => hangingHandle(() => {
          aborted.value = true;
        }),
      }),
    );
    const controller = new AbortController();
    const stream = await sdk(url).chat.completions.create(
      {
        model: "composer-2",
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      },
      { signal: controller.signal },
    );
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.done).toBe(false);
    controller.abort();
    await waitFor(() => aborted.value);
    expect(aborted.value).toBe(true);
  });
});

describe("bin and README", () => {
  it("documents the default loopback baseURL and that this is not @cursor/sdk", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    expect(readme).toContain(DEFAULT_BASE_URL);
    expect(readme).toMatch(/not `@cursor\/sdk`|not @cursor\/sdk/i);
    expect(readme).toContain("CURSOR_API_KEY");
    expect(readme).toContain("CURSOR_RPC_OPENAI_API_KEY");
    expect(readme).toMatch(/tool/i);
    expect(readme).toMatch(/127\.0\.0\.1 or ::1|loopback/i);
  });

  it("does not listen when Cursor env credentials are missing", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    await expect(
      main([], {
        CURSOR_RPC_OPENAI_API_KEY: INBOUND_KEY,
        CURSOR_RPC_OPENAI_HOST: "127.0.0.1",
        CURSOR_RPC_OPENAI_PORT: "0",
      }),
    ).rejects.toThrow(/CURSOR_API_KEY|CURSOR_AUTH_TOKEN|authentication required/i);
    expect(listen).not.toHaveBeenCalled();
  });
});

function hangingHandle(onAbort: () => void): RunHandle {
  let settle: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    abort() {
      onAbort();
      settle?.();
    },
    wait: async () => {
      await blocked;
      throw new CancelledError();
    },
    conversationHistory: () => ({ messages: [] }) as never,
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", text: "hel" };
      await blocked;
      throw new CancelledError();
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for abort");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
