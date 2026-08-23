import { AuthenticationError, CancelledError, type RunHandle } from "cursor-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer } from "../src/server.ts";
import { authHeaders, createCompletion, fakeProvider, startTestServer, thinkingThenHi } from "./helpers.ts";

const servers: StartedServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function start(provider = fakeProvider()) {
  const started = await startTestServer(provider);
  servers.push(started);
  return started;
}

async function readSse(response: Response): Promise<{ contentType: string; text: string; chunks: unknown[] }> {
  const text = await response.text();
  const chunks: unknown[] = [];
  for (const block of text.split("\n\n")) {
    const line = block.trim();
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (data === "[DONE]") {
      chunks.push("[DONE]");
      continue;
    }
    chunks.push(JSON.parse(data) as unknown);
  }
  return { contentType: response.headers.get("content-type") ?? "", text, chunks };
}

describe("chat completions SSE", () => {
  it("streams chat.completion.chunk events ending with [DONE] matching non-stream content", async () => {
    const events = thinkingThenHi();
    const { url } = await start(fakeProvider({ events }));
    const streamed = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    expect(streamed.status).toBe(200);
    const { contentType, text, chunks } = await readSse(streamed);
    expect(contentType).toMatch(/text\/event-stream/);
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);

    const objects = chunks.filter((chunk) => chunk !== "[DONE]") as Array<{
      object: string;
      choices: Array<{ delta: { role?: string; content?: string }; finish_reason: string | null }>;
    }>;
    expect(objects.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(true);
    expect(objects[0]?.choices[0]?.delta.role).toBe("assistant");
    const concat = objects.map((chunk) => chunk.choices[0]?.delta.content ?? "").join("");
    expect(concat).toBe("hi");
    expect(objects.at(-1)?.choices[0]?.delta).toEqual({});
    expect(objects.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    expect(text).not.toContain("I should greet");

    const json = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
    });
    expect((await json.json()).choices[0].message.content).toBe(concat);
  });

  it("emits an empty-choices usage chunk before [DONE] when include_usage is true", async () => {
    const { url } = await start(fakeProvider({ events: thinkingThenHi() }));
    const response = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const { chunks } = await readSse(response);
    expect(chunks.at(-1)).toBe("[DONE]");
    const usageChunk = chunks.at(-2) as { choices: unknown[]; usage: { prompt_tokens: number } };
    expect(usageChunk.choices).toEqual([]);
    expect(usageChunk.usage.prompt_tokens).toBe(4);
  });

  it("aborts provider.run() when a real HTTP client cancels before the first SSE chunk", async () => {
    const aborted = { value: false };
    let entered: (() => void) | undefined;
    const runEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { url } = await start(
      fakeProvider({
        run: async (runOptions) => {
          entered?.();
          await new Promise<never>((_, reject) => {
            const signal = runOptions.signal;
            const fail = () => {
              aborted.value = true;
              reject(new CancelledError());
            };
            if (signal === undefined) {
              return;
            }
            if (signal.aborted) {
              fail();
              return;
            }
            signal.addEventListener("abort", fail, { once: true });
          });
        },
      }),
    );
    const controller = new AbortController();
    const pending = fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], stream: true }),
      signal: controller.signal,
    });
    await runEntered;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await viWaitFor(() => aborted.value);
    expect(aborted.value).toBe(true);
  });

  it("aborts the fake run when a real HTTP client cancels mid-SSE", async () => {
    const aborted = { value: false };
    const { url } = await start(
      fakeProvider({
        run: async () => hangingHandle(() => {
          aborted.value = true;
        }),
      }),
    );
    const controller = new AbortController();
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], stream: true }),
      signal: controller.signal,
    });
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await viWaitFor(() => aborted.value);
    expect(aborted.value).toBe(true);
  });

  it("omits secrets from a mid-stream SSE error line", async () => {
    const { url } = await start(
      fakeProvider({
        run: async () => {
          return {
            abort() {},
            wait: async () => {
              throw new AuthenticationError("Bearer sk-leaked");
            },
            conversationHistory: () => ({ messages: [] }) as never,
            async *[Symbol.asyncIterator]() {
              yield { type: "text_delta", text: "hel" };
              throw new AuthenticationError("Bearer sk-leaked and key_secret");
            },
          } satisfies RunHandle;
        },
      }),
    );
    const response = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    const text = await response.text();
    expect(text).toContain("data: {");
    expect(text).toContain('"error"');
    expect(text).not.toContain("sk-leaked");
    expect(text).not.toContain("key_secret");
    expect(text).not.toContain("sk-inbound-secret");
    expect(text).not.toContain("stack");
    expect(text).not.toContain("[DONE]");
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

async function viWaitFor(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for abort");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
