import { randomBytes } from "node:crypto";
import { AuthenticationError, conversationHistoryFromTurns, type ClientRunOptions } from "cursor-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { openResponseStore, type InsertResponseRow } from "../src/openai/response-store.ts";
import type { StartedServer } from "../src/server.ts";
import {
  authHeaders,
  fakeHandle,
  fakeProvider,
  INBOUND_KEY,
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

function respId(): string {
  return `resp_${randomBytes(16).toString("hex")}`;
}

function failedParentRow(id: string): InsertResponseRow {
  return {
    id,
    status: "failed",
    previousResponseId: null,
    model: "composer-2",
    instructions: "do not inherit",
    store: true,
    createdAt: 1_700_000_000,
    response: {
      id,
      object: "response",
      created_at: 1_700_000_000,
      status: "failed",
      model: "composer-2",
      output: [],
      error: {
        message: "Cursor upstream request failed; this is not caused by the inbound Bearer token",
        type: "api_error",
        param: null,
        code: "cursor_upstream",
      },
    },
    transcript: { user: "hello", assistant: "" },
  };
}

describe("responses create JSON", () => {
  it("returns output_text hi only after thinking then hi", async () => {
    const { url } = await start(fakeProvider({ events: thinkingThenHi() }));
    const response = await createResponse(url, {
      model: "composer-2",
      input: "hello",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(typeof body.id).toBe("string");
    expect(body.id).toMatch(/^resp_[A-Za-z0-9]+$/);
    expect((body.id as string).slice("resp_".length).length).toBeGreaterThanOrEqual(22);
    expect(body.model).toBe("composer-2");
    expect(typeof body.created_at).toBe("number");
    expect(body.error).toBeNull();
    expect(body.incomplete_details).toBeNull();
    expect(body.tools).toEqual([]);
    expect(body.text).toEqual({ format: { type: "text" } });
    expect(body.store).toBe(true);
    expect(body.previous_response_id).toBeNull();
    expect(Object.hasOwn(body, "output_text")).toBe(false);
    const output = body.output as Array<{
      id: string;
      type: string;
      status: string;
      role: string;
      content: Array<{ type: string; text: string; annotations: unknown[] }>;
    }>;
    expect(output).toHaveLength(1);
    expect(output[0]?.type).toBe("message");
    expect(output[0]?.status).toBe("completed");
    expect(output[0]?.role).toBe("assistant");
    expect(output[0]?.id).toMatch(/^msg_[A-Za-z0-9]+$/);
    expect(output[0]?.content).toEqual([{ type: "output_text", text: "hi", annotations: [] }]);
    expect(body.usage).toEqual({ input_tokens: 4, output_tokens: 1, total_tokens: 5 });
    const dumped = JSON.stringify(body);
    expect(dumped).not.toContain("I should greet");
    expect(dumped).not.toContain("notice");
    expect(dumped).not.toContain("output_text\":\"hi");
  });

  it("accepts string input, input_text parts, text parts, and empty tools", async () => {
    const captured: ClientRunOptions[] = [];
    const { url } = await start(
      fakeProvider({
        onRun(options) {
          captured.push(options);
        },
      }),
    );
    const stringRes = await createResponse(url, { input: "hi", tools: [] });
    expect(stringRes.status).toBe(200);
    expect((await stringRes.json()).output[0].content[0].text).toBe("hi");

    const inputTextRes = await createResponse(url, {
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    });
    expect(inputTextRes.status).toBe(200);
    expect((await inputTextRes.json()).output[0].content[0].text).toBe("hi");

    const textRes = await createResponse(url, {
      input: [{ type: "message", role: "user", content: [{ type: "text", text: "hi" }] }],
    });
    expect(textRes.status).toBe(200);
    expect((await textRes.json()).output[0].content[0].text).toBe("hi");
    expect(captured).toHaveLength(3);
    expect(captured.every((options) => options.prompt === "hi")).toBe(true);
  });

  it("maps instructions plus two user/assistant items onto prepended last user and earlier history", async () => {
    let captured: ClientRunOptions | undefined;
    const { url } = await start(
      fakeProvider({
        onRun(options) {
          captured = options;
        },
      }),
    );
    const response = await createResponse(url, {
      instructions: "be brief",
      input: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.instructions).toBe("be brief");
    expect(captured?.prompt).toBe("be brief\n\nc");
    expect(captured?.conversationHistory).toEqual(
      conversationHistoryFromTurns([
        { role: "user", text: "a" },
        { role: "assistant", text: "b" },
      ]),
    );
  });

  it("maps stored parent transcripts into history and does not reuse parent instructions", async () => {
    const captured: ClientRunOptions[] = [];
    const { url } = await start(
      fakeProvider({
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
    const second = await createResponse(url, {
      instructions: "current only",
      input: "next",
      previous_response_id: firstBody.id,
    });
    expect(second.status).toBe(200);
    expect(captured).toHaveLength(2);
    expect(captured[0]?.prompt).toBe("parent only\n\nhello");
    expect(captured[1]?.prompt).toBe("current only\n\nnext");
    expect(captured[1]?.prompt).not.toContain("parent only");
    expect(captured[1]?.conversationHistory).toEqual(
      conversationHistoryFromTurns([
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
      ]),
    );
    expect((await second.json()).previous_response_id).toBe(firstBody.id);
  });

  it("rejects semantic-unsupported fields with 400 and does not call run", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const cases = [
      {
        body: { input: "hi", tools: [{ type: "function", name: "x" }] },
        param: "tools",
      },
      {
        body: {
          input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] }],
        },
        param: "input",
      },
      { body: { input: "hi", background: true }, param: "background" },
      { body: { input: "hi", conversation: "conv_1" }, param: "conversation" },
      {
        body: { input: "hi", text: { format: { type: "json_schema", name: "x" } } },
        param: "text",
      },
      {
        body: { input: [{ type: "function_call", name: "x", arguments: "{}", call_id: "c1" }] },
        param: "input",
      },
      {
        body: { input: [{ type: "web_search_call", id: "ws_1", status: "completed" }] },
        param: "input",
      },
    ];
    for (const item of cases) {
      const response = await createResponse(url, item.body);
      expect(response.status, JSON.stringify(item.param)).toBe(400);
      const payload = await response.json();
      expect(payload.error.type).toBe("invalid_request_error");
      expect(payload.error.param).toBe(item.param);
    }
    expect(runs).toBe(0);
  });

  it("returns 400 param input when there is no user text", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const response = await createResponse(url, {
      instructions: "only instructions",
      input: [{ role: "system", content: "only system" }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.param).toBe("input");
    expect(runs).toBe(0);
  });

  it("returns 404 model_not_found for an unknown model", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const response = await createResponse(url, {
      model: "definitely-not-a-cursor-model",
      input: "hi",
    });
    expect(response.status).toBe(404);
    const payload = await response.json();
    expect(payload.error.code).toBe("model_not_found");
    expect(payload.error.param).toBe("model");
    expect(runs).toBe(0);
  });

  it("returns 400 for store:false then previous_response_id and for a missing parent", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const created = await createResponse(url, { input: "hi", store: false });
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.store).toBe(false);
    expect(createdBody.id).toMatch(/^resp_/);
    expect(runs).toBe(1);

    const retrieved = await fetch(`${url}/v1/responses/${createdBody.id}`, { headers: authHeaders() });
    expect(retrieved.status).toBe(404);

    const chained = await createResponse(url, {
      input: "again",
      previous_response_id: createdBody.id,
    });
    expect(chained.status).toBe(400);
    expect((await chained.json()).error.param).toBe("previous_response_id");

    const missing = await createResponse(url, {
      input: "again",
      previous_response_id: respId(),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error.param).toBe("previous_response_id");
    expect(runs).toBe(1);
  });

  it("maps unauthenticated Cursor AuthenticationError to 502 and pins later creates", async () => {
    let calls = 0;
    const { url } = await start(
      fakeProvider({
        run: async () => {
          calls += 1;
          if (calls === 1) {
            throw new AuthenticationError("invalid Bearer sk-leaked and key_secret", { code: "unauthenticated" });
          }
          return fakeHandle([{ type: "text_delta", text: "hi" }, { type: "turn_ended", usage: {} }]);
        },
      }),
    );
    const first = await createResponse(url, { input: "hi" });
    expect(first.status).toBe(502);
    const firstBody = await first.json();
    expect(firstBody.error.type).toBe("api_error");
    expect(firstBody.error.code).toBe("cursor_upstream");
    expect(firstBody.error.code).not.toBe("invalid_api_key");
    const dumped = JSON.stringify(firstBody);
    expect(dumped).not.toContain("sk-leaked");
    expect(dumped).not.toContain("key_secret");
    expect(dumped).not.toContain(INBOUND_KEY);
    expect(dumped).not.toContain("stack");

    const second = await createResponse(url, { input: "again" });
    expect(second.status).toBe(502);
    expect((await second.json()).error.code).toBe("cursor_upstream");
    expect(calls).toBe(1);
  });

  it("does not let extra body keys widen the ASK pin", async () => {
    let captured: ClientRunOptions | undefined;
    const { url } = await start(
      fakeProvider({
        onRun(options) {
          captured = options;
        },
      }),
    );
    const response = await createResponse(url, {
      input: "hi",
      temperature: 0.1,
      user: "attacker",
      max_output_tokens: 99,
      tool_choice: "none",
      mode: "agent",
      mcpTools: [{ name: "shell" }],
      allowWebSearch: true,
      allowedTools: ["web_search_tool_call"],
      excludeWorkspaceContext: false,
    });
    expect(response.status).toBe(200);
    expect(captured?.mode).toBe("ask");
    expect(captured?.mcpTools).toBeUndefined();
    expect(captured?.allowWebSearch).toBeUndefined();
    expect(captured?.allowWebFetch).toBeUndefined();
    expect(captured?.allowedTools).toBeUndefined();
    expect(captured?.excludeTools).toBeUndefined();
    expect(captured?.maxTokens).toBeUndefined();
    expect(captured?.handlers).toBeUndefined();
    expect(captured).toEqual(
      expect.objectContaining({
        prompt: "hi",
        modelId: "composer-2",
        mode: "ask",
      }),
    );
  });

  it("rejects chaining a failed stored parent with 400 and does not call run", async () => {
    const dbPath = tempResponsesDbPath();
    const parentId = respId();
    const store = openResponseStore(dbPath);
    store.insert(failedParentRow(parentId));
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
    const response = await createResponse(url, {
      input: "next",
      previous_response_id: parentId,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.param).toBe("previous_response_id");
    expect(runs).toBe(0);
  });

  it("completes overlapping POSTs against independent fake runs", async () => {
    let calls = 0;
    const { url } = await start(
      fakeProvider({
        run: async () => {
          calls += 1;
          const index = calls;
          return fakeHandle([
            { type: "text_delta", text: `n${index}` },
            { type: "turn_ended", usage: {} },
          ]);
        },
      }),
    );
    const [a, b] = await Promise.all([
      createResponse(url, { input: "a" }),
      createResponse(url, { input: "b" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const texts = [
      (await a.json()).output[0].content[0].text,
      (await b.json()).output[0].content[0].text,
    ].sort();
    expect(texts).toEqual(["n1", "n2"]);
  });

  it("persists store omitted or true and GET matches the create body", async () => {
    const { url } = await start();
    const created = await createResponse(url, { input: "hello" });
    expect(created.status).toBe(200);
    const body = await created.json();
    const retrieved = await fetch(`${url}/v1/responses/${body.id}`, { headers: authHeaders() });
    expect(retrieved.status).toBe(200);
    expect(await retrieved.json()).toEqual(body);
  });
});
