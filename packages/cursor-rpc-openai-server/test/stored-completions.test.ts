import { CancelledError, type RunHandle } from "cursor-rpc";
import { afterEach, describe, expect, it } from "vitest";
import type { StartedServer } from "../src/server.ts";
import {
  authHeaders,
  createCompletion,
  fakeProvider,
  startTestServer,
  tempResponsesDbPath,
  thinkingThenHi,
} from "./helpers.ts";

const servers: StartedServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function start(provider = fakeProvider(), env: Record<string, string | undefined> = {}) {
  const started = await startTestServer(provider, env);
  servers.push(started);
  return started;
}

async function getCompletion(url: string, id: string, headers: Record<string, string> = authHeaders()) {
  return fetch(`${url}/v1/chat/completions/${id}`, { headers });
}

async function listCompletions(url: string, query = "", headers: Record<string, string> = authHeaders()) {
  return fetch(`${url}/v1/chat/completions${query}`, { headers });
}

async function updateCompletion(url: string, id: string, body: unknown, headers: Record<string, string> = authHeaders()) {
  return fetch(`${url}/v1/chat/completions/${id}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteCompletion(url: string, id: string, headers: Record<string, string> = authHeaders()) {
  return fetch(`${url}/v1/chat/completions/${id}`, { method: "DELETE", headers });
}

async function createStored(
  url: string,
  extras: Record<string, unknown> = {},
): Promise<{ id: string; content: string; body: Record<string, unknown> }> {
  const response = await createCompletion(url, {
    model: "composer-2",
    messages: [{ role: "user", content: "hello" }],
    store: true,
    ...extras,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    id: string;
    choices: Array<{ message: { content: string } }>;
  };
  return { id: body.id, content: body.choices[0]?.message.content ?? "", body };
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

async function viWaitFor(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for abort");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("stored chat completions", () => {
  it("returns store:true create content after listener restart using the same id", async () => {
    const dbPath = tempResponsesDbPath();
    const first = await start(fakeProvider({ events: thinkingThenHi() }), {
      CURSOR_RPC_OPENAI_RESPONSES_DB: dbPath,
    });
    const created = await createStored(first.url);
    expect(created.id).toMatch(/^chatcmpl-/);
    expect(created.content).toBe("hi");
    await first.close();

    const second = await start(fakeProvider(), { CURSOR_RPC_OPENAI_RESPONSES_DB: dbPath });
    const retrieved = await getCompletion(second.url, created.id);
    expect(retrieved.status).toBe(200);
    const stored = (await retrieved.json()) as {
      id: string;
      object: string;
      choices: Array<{ message: { role: string; content: string } }>;
    };
    expect(stored.object).toBe("chat.completion");
    expect(stored.id).toBe(created.id);
    expect(stored.choices[0]?.message).toEqual({ role: "assistant", content: "hi" });
  });

  it("returns 404 for GET when store is omitted or false", async () => {
    const { url } = await start();
    const omitted = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
    });
    expect(omitted.status).toBe(200);
    const omittedId = ((await omitted.json()) as { id: string }).id;
    expect((await getCompletion(url, omittedId)).status).toBe(404);

    const falsy = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
      store: false,
    });
    expect(falsy.status).toBe(200);
    const falsyId = ((await falsy.json()) as { id: string }).id;
    expect((await getCompletion(url, falsyId)).status).toBe(404);
  });

  it("dispatches GET /v1/chat/completions to list and POST to create without running GET", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const listed = await listCompletions(url);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      object: "list",
      data: [],
      first_id: null,
      last_id: null,
      has_more: false,
    });
    expect(runs).toBe(0);

    const created = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
    });
    expect(created.status).toBe(200);
    expect(runs).toBe(1);
  });

  it("filters list by metadata and reflects update then GET", async () => {
    const { url } = await start();
    const alpha = await createStored(url, { metadata: { team: "alpha" } });
    const beta = await createStored(url, { metadata: { team: "beta" } });
    const listed = await listCompletions(url, `?${new URLSearchParams({ "metadata[team]": "alpha" }).toString()}`);
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { data: Array<{ id: string; metadata: Record<string, string> }> };
    expect(page.data.map((row) => row.id)).toEqual([alpha.id]);
    expect(page.data[0]?.metadata).toEqual({ team: "alpha" });
    expect(page.data.some((row) => row.id === beta.id)).toBe(false);

    const updated = await updateCompletion(url, alpha.id, { metadata: { team: "gamma" } });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      id: string;
      metadata: Record<string, string>;
      choices: Array<{ message: { content: string } }>;
    };
    expect(updatedBody.id).toBe(alpha.id);
    expect(updatedBody.metadata).toEqual({ team: "gamma" });
    expect(updatedBody.choices[0]?.message.content).toBe("hi");

    const retrieved = await getCompletion(url, alpha.id);
    expect((await retrieved.json()).metadata).toEqual({ team: "gamma" });
  });

  it("inserts a streamed store:true completion once after [DONE] and inserts nothing on abort", async () => {
    const { url } = await start(fakeProvider({ events: thinkingThenHi() }));
    const streamed = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      store: true,
    });
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    const id = text.match(/"id":"(chatcmpl-[^"]+)"/)?.[1];
    expect(id).toMatch(/^chatcmpl-/);
    const retrieved = await getCompletion(url, id!);
    expect(retrieved.status).toBe(200);
    expect((await retrieved.json()).choices[0].message.content).toBe("hi");
    const listed = await listCompletions(url);
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);

    const aborted = { value: false };
    const aborting = await start(
      fakeProvider({
        run: async () =>
          hangingHandle(() => {
            aborted.value = true;
          }),
      }),
    );
    const controller = new AbortController();
    const response = await fetch(`${aborting.url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }], stream: true, store: true }),
      signal: controller.signal,
    });
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let streamId: string | undefined;
    while (streamId === undefined) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      streamId = buffered.match(/"id":"(chatcmpl-[^"]+)"/)?.[1];
    }
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    await viWaitFor(() => aborted.value);
    expect(streamId).toMatch(/^chatcmpl-/);
    expect((await getCompletion(aborting.url, streamId!)).status).toBe(404);
  });

  it("allows empty tools with store:true and rejects non-empty tools without inserting", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const allowed = await createStored(url, { tools: [] });
    expect((await getCompletion(url, allowed.id)).status).toBe(200);
    expect(runs).toBe(1);

    const rejected = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
      store: true,
      tools: [{ type: "function", function: { name: "x" } }],
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.param).toBe("tools");
    expect(runs).toBe(1);
    const listed = await listCompletions(url);
    expect(((await listed.json()) as { data: unknown[] }).data).toHaveLength(1);
  });

  it("lists with default limit 20, after pagination, and empty first/last ids", async () => {
    const emptyServer = await start();
    const empty = await listCompletions(emptyServer.url);
    expect(await empty.json()).toEqual({
      object: "list",
      data: [],
      first_id: null,
      last_id: null,
      has_more: false,
    });

    const { url } = await start();
    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      ids.push((await createStored(url, { metadata: { i: String(i) } })).id);
    }
    const firstPage = (await (await listCompletions(url)).json()) as {
      data: Array<{ id: string }>;
      first_id: string | null;
      last_id: string | null;
      has_more: boolean;
    };
    expect(firstPage.data).toHaveLength(20);
    expect(firstPage.first_id).toBe(firstPage.data[0]?.id);
    expect(firstPage.last_id).toBe(firstPage.data[19]?.id);
    expect(firstPage.has_more).toBe(true);

    const secondPage = (await (await listCompletions(url, `?after=${firstPage.last_id}`)).json()) as {
      data: Array<{ id: string }>;
      first_id: string | null;
      last_id: string | null;
      has_more: boolean;
    };
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.first_id).toBe(secondPage.data[0]?.id);
    expect(secondPage.last_id).toBe(secondPage.data[0]?.id);
    expect(secondPage.has_more).toBe(false);
    const listed = new Set([...firstPage.data, ...secondPage.data].map((row) => row.id));
    expect(listed.size).toBe(21);
    expect(ids.every((id) => listed.has(id))).toBe(true);
  });

  it("deletes a stored completion and 404s unknown get/update/delete", async () => {
    const { url } = await start();
    const stored = await createStored(url);
    const deleted = await deleteCompletion(url, stored.id);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      id: stored.id,
      deleted: true,
      object: "chat.completion.deleted",
    });
    expect((await getCompletion(url, stored.id)).status).toBe(404);

    const missing = "chatcmpl-missing";
    expect((await getCompletion(url, missing)).status).toBe(404);
    expect((await updateCompletion(url, missing, { metadata: { team: "x" } })).status).toBe(404);
    expect((await deleteCompletion(url, missing)).status).toBe(404);
  });

  it("returns 400 for unknown after and 401 for the wrong Bearer on CRUD", async () => {
    const { url } = await start();
    const stored = await createStored(url);
    const after = await listCompletions(url, "?after=chatcmpl-missing");
    expect(after.status).toBe(400);
    expect((await after.json()).error.param).toBe("after");

    const wrong = { Authorization: "Bearer sk-wrong" };
    expect((await listCompletions(url, "", wrong)).status).toBe(401);
    expect((await getCompletion(url, stored.id, wrong)).status).toBe(401);
    expect((await updateCompletion(url, stored.id, { metadata: { team: "x" } }, wrong)).status).toBe(401);
    expect((await deleteCompletion(url, stored.id, wrong)).status).toBe(401);
  });

  it("ignores extra update keys and leaves stored content unchanged", async () => {
    const { url } = await start();
    const stored = await createStored(url, { metadata: { team: "alpha" } });
    const updated = await updateCompletion(url, stored.id, {
      metadata: { team: "beta" },
      id: "chatcmpl-forged",
      choices: [{ index: 0, message: { role: "assistant", content: "mutated" }, finish_reason: "stop" }],
    });
    expect(updated.status).toBe(200);
    const body = (await updated.json()) as {
      id: string;
      metadata: Record<string, string>;
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.id).toBe(stored.id);
    expect(body.metadata).toEqual({ team: "beta" });
    expect(body.choices[0]?.message.content).toBe("hi");

    const retrieved = (await (await getCompletion(url, stored.id)).json()) as {
      id: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(retrieved.id).toBe(stored.id);
    expect(retrieved.choices[0]?.message.content).toBe("hi");
  });

  it("rejects hostile list order and keeps metadata filters bound", async () => {
    const { url } = await start();
    const stored = await createStored(url, { metadata: { team: "alpha" } });
    const order = await listCompletions(url, "?order=drop-table");
    expect(order.status).toBe(400);
    expect((await order.json()).error.param).toBe("order");

    const hostileKey = "foo'; DROP TABLE chat_completions;--";
    const hostile = await listCompletions(
      url,
      `?${new URLSearchParams({ [`metadata[${hostileKey}]`]: "alpha" }).toString()}`,
    );
    expect(hostile.status).toBe(200);
    const page = (await hostile.json()) as { data: Array<{ id: string }> };
    expect(page.data).toEqual([]);
    expect((await getCompletion(url, stored.id)).status).toBe(200);
  });

  it("validates metadata before run when store is true and ignores it when not storing", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const invalid = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
      store: true,
      metadata: { count: 1 },
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.param).toBe("metadata");
    expect(runs).toBe(0);

    const ignored = await createCompletion(url, {
      messages: [{ role: "user", content: "hello" }],
      metadata: { count: 1 },
    });
    expect(ignored.status).toBe(200);
    expect(runs).toBe(1);
    expect((await getCompletion(url, ((await ignored.json()) as { id: string }).id)).status).toBe(404);
  });

  it("treats omitted update metadata as a no-op and null as empty", async () => {
    const { url } = await start();
    const stored = await createStored(url, { metadata: { team: "alpha" } });
    const noop = await updateCompletion(url, stored.id, { choices: [] });
    expect(noop.status).toBe(200);
    expect((await noop.json()).metadata).toEqual({ team: "alpha" });

    const cleared = await updateCompletion(url, stored.id, { metadata: null });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).metadata).toEqual({});
  });
});
