import { AuthenticationError, CancelledError, StreamError, conversationHistoryFromTurns, type ClientRunOptions, type RunHandle } from "cursor-rpc";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import type { StartedServer } from "../src/server.ts";
import {
  authHeaders,
  fakeProvider,
  INBOUND_KEY,
  startTestServer,
  thinkingThenHi,
} from "./helpers.ts";

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

async function createResponse(url: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${url}/v1/responses`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
    ...init,
  });
}

function sdk(url: string) {
  return new OpenAI({
    apiKey: INBOUND_KEY,
    baseURL: `${url}/v1`,
    maxRetries: 0,
  });
}

function helloEvents() {
  return [
    { type: "thinking_delta" as const, text: "I should greet" },
    { type: "server_notice" as const, text: "notice" },
    { type: "text_delta" as const, text: "hel" },
    { type: "text_delta" as const, text: "lo" },
    { type: "turn_ended" as const, usage: { inputTokens: 4, outputTokens: 2 } },
  ];
}

const LADDER_WITHOUT_DELTAS = [
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.done",
  "response.content_part.done",
  "response.output_item.done",
  "response.completed",
] as const;

function collapseDeltaTypes(types: string[]): string[] {
  const collapsed: string[] = [];
  for (const type of types) {
    if (type === "response.output_text.delta" && collapsed.at(-1) === type) {
      continue;
    }
    collapsed.push(type);
  }
  return collapsed;
}

type ParsedFrame = { event: string; data: Record<string, unknown> };

function parseResponsesSse(text: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
    if (lines.length === 0) {
      continue;
    }
    let event: string | undefined;
    let data: Record<string, unknown> | undefined;
    for (const line of lines) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        const raw = line.slice("data:".length).trim();
        expect(raw).not.toBe("[DONE]");
        data = JSON.parse(raw) as Record<string, unknown>;
      }
    }
    if (event !== undefined && data !== undefined) {
      frames.push({ event, data });
    }
  }
  return frames;
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

describe("responses SSE", () => {
  it("streams official-SDK-parseable event order with output_item.added before the first delta", async () => {
    const events = helloEvents();
    const { url } = await start(fakeProvider({ events }));
    const client = sdk(url);
    const stream = await client.responses.create({
      model: "composer-2",
      input: "hello",
      stream: true,
    });
    const types: string[] = [];
    const deltas: string[] = [];
    let seenItemAdded = false;
    let itemAddedBeforeFirstDelta = false;
    const created: Array<Record<string, unknown>> = [];
    for await (const event of stream) {
      types.push(event.type);
      if (event.type === "response.output_item.added") {
        seenItemAdded = true;
      }
      if (event.type === "response.output_text.delta") {
        if (!itemAddedBeforeFirstDelta) {
          itemAddedBeforeFirstDelta = seenItemAdded;
        }
        deltas.push(event.delta);
      }
      if (event.type === "response.created" || event.type === "response.in_progress") {
        created.push(event.response as unknown as Record<string, unknown>);
      }
      if (event.type === "response.completed") {
        expect(event.response.usage).toEqual({
          input_tokens: 4,
          output_tokens: 2,
          total_tokens: 6,
        });
        expect(event.response.status).toBe("completed");
      }
    }
    expect(types[0]).toBe("response.created");
    expect(collapseDeltaTypes(types)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      ...LADDER_WITHOUT_DELTAS.slice(4),
    ]);
    expect(itemAddedBeforeFirstDelta).toBe(true);
    expect(deltas.join("")).toBe("hello");
    expect(created).toHaveLength(2);
    for (const response of created) {
      expect(response.output).toEqual([]);
      expect(response.usage).toBeNull();
      expect(response.status).toBe("in_progress");
    }

    const runner = client.responses.stream({
      model: "composer-2",
      input: "hello",
    });
    const final = await runner.finalResponse();
    const json = await createResponse(url, { input: "hello" });
    expect(json.status).toBe(200);
    const body = await json.json();
    expect(deltas.join("")).toBe(body.output[0].content[0].text);
    expect(final.output[0]).toMatchObject({
      type: "message",
      content: [{ type: "output_text", text: "hello" }],
    });
  });

  it("writes event and data frames with matching type and monotonic sequence_number", async () => {
    const { url } = await start(fakeProvider({ events: helloEvents() }));
    const response = await createResponse(url, { input: "hello", stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);
    const text = await response.text();
    expect(text).not.toContain("data: [DONE]");
    expect(text).not.toContain("chat.completion.chunk");
    expect(text).not.toContain("I should greet");
    expect(text).not.toContain("notice");
    const frames = parseResponsesSse(text);
    expect(frames.map((frame) => frame.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    frames.forEach((frame, index) => {
      expect(frame.data.type).toBe(frame.event);
      expect(frame.data.sequence_number).toBe(index);
    });
  });

  it("streams previous_response_id with the same prep and ancestor history as JSON", async () => {
    const captured: ClientRunOptions[] = [];
    const { url } = await start(
      fakeProvider({
        events: thinkingThenHi(),
        onRun(options) {
          captured.push(options);
        },
      }),
    );
    const first = await createResponse(url, {
      instructions: "parent only",
      input: "hello",
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    const streamed = await createResponse(url, {
      instructions: "current only",
      input: "next",
      previous_response_id: firstBody.id,
      stream: true,
    });
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text).toContain("event: response.completed");
    expect(captured).toHaveLength(2);
    expect(captured[1]?.prompt).toBe("current only\n\nnext");
    expect(captured[1]?.prompt).not.toContain("parent only");
    expect(captured[1]?.conversationHistory).toEqual(
      conversationHistoryFromTurns([
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
      ]),
    );
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
    const pending = fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ input: "hello", stream: true }),
      signal: controller.signal,
    });
    await runEntered;
    controller.abort();
    await expect(pending).rejects.toThrow();
    await viWaitFor(() => aborted.value);
    expect(aborted.value).toBe(true);
  });

  it("aborts the fake run on a real HTTP client cancel mid-SSE and does not commit a completed row", async () => {
    const aborted = { value: false };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const { url } = await start(
      fakeProvider({
        run: async () => hangingHandle(() => {
          aborted.value = true;
        }),
      }),
    );
    const controller = new AbortController();
    const response = await fetch(`${url}/v1/responses`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ input: "hello", stream: true }),
      signal: controller.signal,
    });
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let responseId: string | undefined;
    while (responseId === undefined) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      const created = buffered.match(/"id":"(resp_[A-Za-z0-9]+)"/);
      responseId = created?.[1];
    }
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await viWaitFor(() => aborted.value);
    expect(aborted.value).toBe(true);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(responseId).toMatch(/^resp_/);
    const retrieved = await fetch(`${url}/v1/responses/${responseId}`, { headers: authHeaders() });
    expect(retrieved.status).toBe(404);
  });

  it("emits typed failed/error events on mid-stream StreamError and commits failed when store is true", async () => {
    const { url } = await start(
      fakeProvider({
        run: async () => {
          return {
            abort() {},
            wait: async () => {
              throw new StreamError("Bearer sk-leaked and key_secret");
            },
            conversationHistory: () => ({ messages: [] }) as never,
            async *[Symbol.asyncIterator]() {
              yield { type: "text_delta", text: "hel" };
              throw new StreamError("Bearer sk-leaked and key_secret");
            },
          } satisfies RunHandle;
        },
      }),
    );
    const response = await createResponse(url, { input: "hello", stream: true });
    const text = await response.text();
    expect(text).not.toContain("chat.completion.chunk");
    expect(text).not.toMatch(/\ndata: \{"error":/);
    expect(text).toMatch(/event: response\.failed|event: error/);
    const frames = parseResponsesSse(text);
    const types = frames.map((frame) => frame.event);
    expect(types.some((type) => type === "response.failed" || type === "error")).toBe(true);
    expect(types).not.toContain("response.completed");
    const created = frames.find((frame) => frame.event === "response.created");
    const responseId = (created?.data.response as { id?: string } | undefined)?.id;
    expect(responseId).toMatch(/^resp_/);
    const retrieved = await fetch(`${url}/v1/responses/${responseId}`, { headers: authHeaders() });
    expect(retrieved.status).toBe(200);
    expect((await retrieved.json()).status).toBe("failed");
  });

  it("omits inbound key, Cursor token material, and stack from failed SSE error.message", async () => {
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
    const response = await createResponse(url, { input: "hello", stream: true });
    const text = await response.text();
    expect(text).toMatch(/event: response\.failed|event: error/);
    expect(text).not.toContain("sk-leaked");
    expect(text).not.toContain("key_secret");
    expect(text).not.toContain(INBOUND_KEY);
    expect(text).not.toContain("stack");
    expect(text).not.toContain("chat.completion.chunk");
    expect(text).not.toContain("data: [DONE]");
  });
});
