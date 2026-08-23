import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openResponseStore, type InsertResponseRow } from "../src/openai/response-store.ts";
import type { StartedServer } from "../src/server.ts";
import { authHeaders, fakeProvider, startTestServer, tempResponsesDbPath } from "./helpers.ts";

const servers: StartedServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

async function start(
  provider = fakeProvider(),
  env: Record<string, string | undefined> = {},
) {
  const started = await startTestServer(provider, env);
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

async function getResponse(url: string, id: string, query = "", headers: Record<string, string> = authHeaders()) {
  return fetch(`${url}/v1/responses/${id}${query}`, { headers });
}

async function deleteResponse(url: string, id: string, headers: Record<string, string> = authHeaders()) {
  return fetch(`${url}/v1/responses/${id}`, { method: "DELETE", headers });
}

async function cancelResponse(url: string, id: string, headers: Record<string, string> = authHeaders()) {
  return fetch(`${url}/v1/responses/${id}/cancel`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
  });
}

async function compactResponses(url: string, body: unknown = {}, headers: Record<string, string> = authHeaders()) {
  return fetch(`${url}/v1/responses/compact`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function respId(): string {
  return `resp_${randomBytes(16).toString("hex")}`;
}

function failedRow(id: string): InsertResponseRow {
  return {
    id,
    status: "failed",
    previousResponseId: null,
    model: "composer-2",
    instructions: null,
    store: true,
    createdAt: 1_700_000_000,
    response: {
      id,
      object: "response",
      created_at: 1_700_000_000,
      status: "failed",
      model: "composer-2",
      output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      instructions: null,
      store: true,
      previous_response_id: null,
      error: {
        message: "Cursor upstream request failed; this is not caused by the inbound Bearer token",
        type: "api_error",
        param: null,
        code: "cursor_upstream",
      },
      incomplete_details: null,
      tools: [],
      text: { format: { type: "text" } },
    },
    transcript: { user: "hello", assistant: "" },
  };
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

describe("responses lifecycle", () => {
  it("deletes a stored response then GET 404s and previous_response_id is 400", async () => {
    const { url } = await start();
    const created = await createResponse(url, { input: "hello" });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { id: string };
    const deleted = await deleteResponse(url, body.id);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({
      id: body.id,
      object: "response",
      deleted: true,
    });
    expect((await getResponse(url, body.id)).status).toBe(404);
    const chained = await createResponse(url, {
      input: "next",
      previous_response_id: body.id,
    });
    expect(chained.status).toBe(400);
    expect((await chained.json()).error.param).toBe("previous_response_id");
  });

  it("replays stored completed text as a 004 SSE ladder without calling run", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const created = await createResponse(url, { input: "hello" });
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      id: string;
      output: Array<{ id: string; content: Array<{ text: string }> }>;
    };
    expect(runs).toBe(1);

    const streamed = await getResponse(
      url,
      body.id,
      "?stream=true&include=reasoning.encrypted_content&include_obfuscation=true",
    );
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);
    const text = await streamed.text();
    expect(text).not.toContain("data: [DONE]");
    const frames = parseResponsesSse(text);
    expect(frames.map((frame) => frame.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const deltas = frames.filter((frame) => frame.event === "response.output_text.delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.data.delta).toBe(body.output[0]?.content[0]?.text);
    frames.forEach((frame, index) => {
      expect(frame.data.type).toBe(frame.event);
      expect(frame.data.sequence_number).toBe(index);
    });
    const createdFrame = frames[0]?.data.response as { output: unknown; usage: unknown; status: string };
    const inProgressFrame = frames[1]?.data.response as { output: unknown; usage: unknown; status: string };
    expect(createdFrame.output).toEqual([]);
    expect(createdFrame.usage).toBeNull();
    expect(createdFrame.status).toBe("in_progress");
    expect(inProgressFrame.output).toEqual([]);
    expect(inProgressFrame.usage).toBeNull();
    expect(inProgressFrame.status).toBe("in_progress");
    expect((frames.at(-1)?.data.response as { status: string }).status).toBe("completed");
    expect(runs).toBe(1);

    const json = await getResponse(url, body.id, "?include=reasoning.encrypted_content");
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type") ?? "").toMatch(/application\/json/);
    expect(await json.json()).toEqual(body);
  });

  it("replays a stored failed row as failed/error close, not response.completed", async () => {
    const dbPath = tempResponsesDbPath();
    const id = respId();
    const store = openResponseStore(dbPath);
    store.insert(failedRow(id));
    store.close();

    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
      { CURSOR_RPC_OPENAI_RESPONSES_DB: dbPath },
    );
    const streamed = await getResponse(url, id, "?stream=true");
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type") ?? "").toMatch(/text\/event-stream/);
    const text = await streamed.text();
    expect(text).not.toContain("data: [DONE]");
    const frames = parseResponsesSse(text);
    const types = frames.map((frame) => frame.event);
    expect(types.some((type) => type === "response.failed" || type === "error")).toBe(true);
    expect(types).toContain("response.failed");
    expect(types).toContain("error");
    expect(types).not.toContain("response.completed");
    expect(runs).toBe(0);
  });

  it("applies starting_after only to synthetic replay sequence numbers", async () => {
    const { url } = await start();
    const created = await createResponse(url, { input: "hello" });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { id: string };
    const streamed = await getResponse(url, body.id, "?stream=true&starting_after=3");
    expect(streamed.status).toBe(200);
    const frames = parseResponsesSse(await streamed.text());
    expect(frames.map((frame) => frame.event)).toEqual([
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    frames.forEach((frame, index) => {
      expect(frame.data.sequence_number).toBe(index + 4);
    });
  });

  it("returns 400 for cancel of a stored completed or failed id and never calls run", async () => {
    const dbPath = tempResponsesDbPath();
    const failedId = respId();
    const store = openResponseStore(dbPath);
    store.insert(failedRow(failedId));
    store.close();

    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
      { CURSOR_RPC_OPENAI_RESPONSES_DB: dbPath },
    );
    const created = await createResponse(url, { input: "hello" });
    expect(created.status).toBe(200);
    const completedId = (await created.json()).id as string;
    expect(runs).toBe(1);

    const cancelled = await cancelResponse(url, completedId);
    expect(cancelled.status).toBe(400);
    const cancelledBody = await cancelled.json();
    expect(cancelledBody.error.type).toBe("invalid_request_error");
    expect(cancelledBody.error.param).toBe("response_id");
    expect(cancelledBody.object).not.toBe("response");

    const failedCancel = await cancelResponse(url, failedId);
    expect(failedCancel.status).toBe(400);
    expect((await failedCancel.json()).error.param).toBe("response_id");
    expect(runs).toBe(1);
  });

  it("returns 400 for compact of any JSON body before run", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const response = await compactResponses(url, {
      model: "composer-2",
      input: "hello",
      previous_response_id: respId(),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBe("compact");
    expect(String(body.error.message).toLowerCase()).toMatch(/compaction|encrypted_content/);
    expect(body.object).not.toBe("response.compaction");
    expect(body.output).toBeUndefined();
    expect(runs).toBe(0);
  });

  it("returns 404 for cancel of unknown or unstored ids and for delete of unknown ids", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const unknown = respId();
    expect((await cancelResponse(url, unknown)).status).toBe(404);
    expect((await deleteResponse(url, unknown)).status).toBe(404);

    const unstored = await createResponse(url, { input: "hello", store: false });
    expect(unstored.status).toBe(200);
    const unstoredId = (await unstored.json()).id as string;
    expect(runs).toBe(1);
    expect((await cancelResponse(url, unstoredId)).status).toBe(404);
    expect((await deleteResponse(url, unstoredId)).status).toBe(404);
    expect((await getResponse(url, unstoredId)).status).toBe(404);
    expect(runs).toBe(1);
  });

  it("returns 401 for the wrong Bearer on delete, cancel, and compact", async () => {
    const { url } = await start();
    const created = await createResponse(url, { input: "hello" });
    expect(created.status).toBe(200);
    const id = (await created.json()).id as string;
    const wrong = { Authorization: "Bearer sk-wrong" };
    expect((await deleteResponse(url, id, wrong)).status).toBe(401);
    expect((await cancelResponse(url, id, wrong)).status).toBe(401);
    expect((await compactResponses(url, { input: "hello" }, wrong)).status).toBe(401);
    expect((await getResponse(url, id)).status).toBe(200);
  });

  it("does not delete sibling rows; forked children of a deleted parent still 400 on chain", async () => {
    const { url } = await start();
    const parent = await createResponse(url, { input: "parent" });
    expect(parent.status).toBe(200);
    const parentId = (await parent.json()).id as string;

    const childA = await createResponse(url, { input: "child-a", previous_response_id: parentId });
    const childB = await createResponse(url, { input: "child-b", previous_response_id: parentId });
    expect(childA.status).toBe(200);
    expect(childB.status).toBe(200);
    const childAId = (await childA.json()).id as string;
    const childBId = (await childB.json()).id as string;

    const sibling = await createResponse(url, { input: "sibling" });
    expect(sibling.status).toBe(200);
    const siblingId = (await sibling.json()).id as string;

    expect((await deleteResponse(url, parentId)).status).toBe(200);
    expect((await getResponse(url, parentId)).status).toBe(404);
    expect((await getResponse(url, childAId)).status).toBe(200);
    expect((await getResponse(url, childBId)).status).toBe(200);
    expect((await getResponse(url, siblingId)).status).toBe(200);

    const fromDeleted = await createResponse(url, { input: "next", previous_response_id: parentId });
    expect(fromDeleted.status).toBe(400);
    expect((await fromDeleted.json()).error.param).toBe("previous_response_id");

    const fromChild = await createResponse(url, { input: "next", previous_response_id: childAId });
    expect(fromChild.status).toBe(400);
    expect((await fromChild.json()).error.param).toBe("previous_response_id");
  });
});
