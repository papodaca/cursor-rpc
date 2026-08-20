import { conversationHistoryFromTurns, type ClientRunOptions } from "cursor-rpc";
import { afterEach, describe, expect, it } from "vitest";
import { type StartedServer } from "../src/server.ts";
import {
  AuthenticationError,
  createCompletion,
  fakeHandle,
  fakeProvider,
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

describe("chat completions JSON", () => {
  it("returns assistant content without thinking text", async () => {
    const { url } = await start(fakeProvider({ events: thinkingThenHi() }));
    const response = await createCompletion(url, {
      model: "composer-2",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.model).toBe("composer-2");
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0]?.message).toEqual({ role: "assistant", content: "hi" });
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
    expect(JSON.stringify(body)).not.toContain("I should greet");
    expect(JSON.stringify(body)).not.toContain("notice");
  });

  it("accepts text parts and empty tools", async () => {
    let ran = false;
    const { url } = await start(
      fakeProvider({
        onRun() {
          ran = true;
        },
      }),
    );
    const response = await createCompletion(url, {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    });
    expect(response.status).toBe(200);
    expect(ran).toBe(true);
    expect((await response.json()).choices[0].message.content).toBe("hi");
  });

  it("maps system plus earlier turns onto ASK history without duplicating the last user", async () => {
    let captured: ClientRunOptions | undefined;
    const { url } = await start(
      fakeProvider({
        onRun(options) {
          captured = options;
        },
      }),
    );
    const response = await createCompletion(url, {
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    });
    expect(response.status).toBe(200);
    expect(captured?.prompt).toBe("be brief\n\nc");
    expect(captured?.conversationHistory).toEqual(
      conversationHistoryFromTurns([
        { role: "user", text: "a" },
        { role: "assistant", text: "b" },
      ]),
    );
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
      { body: { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "x" } }] }, param: "tools" },
      { body: { messages: [{ role: "user", content: "hi" }], n: 2 }, param: "n" },
      {
        body: {
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }] }],
        },
        param: "messages",
      },
      {
        body: { messages: [{ role: "user", content: "hi" }], response_format: { type: "json_schema", json_schema: { name: "x" } } },
        param: "response_format",
      },
    ];
    for (const item of cases) {
      const response = await createCompletion(url, item.body);
      expect(response.status, JSON.stringify(item.param)).toBe(400);
      const payload = await response.json();
      expect(payload.error.type).toBe("invalid_request_error");
      expect(payload.error.param).toBe(item.param);
    }
    expect(runs).toBe(0);
  });

  it("returns 400 when there is no user message", async () => {
    let runs = 0;
    const { url } = await start(
      fakeProvider({
        onRun() {
          runs += 1;
        },
      }),
    );
    const response = await createCompletion(url, {
      messages: [{ role: "system", content: "only system" }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.param).toBe("messages");
    expect(runs).toBe(0);
  });

  it("maps Cursor AuthenticationError to 502 and pins later creates", async () => {
    const { url } = await start(
      fakeProvider({
        run: async () => {
          throw new AuthenticationError("invalid Bearer sk-leaked and key_secret");
        },
      }),
    );
    const first = await createCompletion(url, {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(first.status).toBe(502);
    const firstBody = await first.json();
    expect(firstBody.error.type).toBe("api_error");
    expect(firstBody.error.code).not.toBe("invalid_api_key");
    const dumped = JSON.stringify(firstBody);
    expect(dumped).not.toContain("sk-leaked");
    expect(dumped).not.toContain("key_secret");
    expect(dumped).not.toContain("sk-inbound-secret");
    expect(dumped).not.toContain("stack");

    const second = await createCompletion(url, {
      messages: [{ role: "user", content: "again" }],
    });
    expect(second.status).toBe(502);
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
    const response = await createCompletion(url, {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.1,
      user: "attacker",
      max_tokens: 99,
      tool_choice: "none",
      mode: "agent",
      mcpTools: [{ name: "shell" }],
      allowWebSearch: true,
      allowedTools: ["web_search_tool_call"],
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
      createCompletion(url, { messages: [{ role: "user", content: "a" }] }),
      createCompletion(url, { messages: [{ role: "user", content: "b" }] }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const texts = [(await a.json()).choices[0].message.content, (await b.json()).choices[0].message.content].sort();
    expect(texts).toEqual(["n1", "n2"]);
  });
});
