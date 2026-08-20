import { afterEach, describe, expect, it } from "vitest";
import { StreamError, TransportUnsupportedError } from "cursor-rpc";
import { streamCursor } from "../src/stream.ts";
import { asTestStream, fakeEpoch, TEST_MODEL, waitForStream } from "./helpers.ts";

const originalKey = process.env.CURSOR_API_KEY;

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.CURSOR_API_KEY;
  } else {
    process.env.CURSOR_API_KEY = originalKey;
  }
});

function withKey(): void {
  process.env.CURSOR_API_KEY = "key_live_test";
}

describe("streamSimple mapping", () => {
  it("text deltas then turn_ended produce Pi stop", async () => {
    withKey();
    const { epoch } = fakeEpoch({
      events: [
        { type: "text_delta", text: "hello" },
        { type: "turn_ended", usage: { inputTokens: 1, outputTokens: 2 } },
      ],
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }),
    );
    await waitForStream(stream);
    expect(stream.events.some((event) => event.type === "text_delta")).toBe(true);
    const done = stream.events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.reason : undefined).toBe("stop");
  });

  it("thinking deltas map to Pi thinking blocks without leaking into text", async () => {
    withKey();
    const { epoch } = fakeEpoch({
      events: [
        { type: "thinking_delta", text: "plan" },
        { type: "text_delta", text: "hello" },
        { type: "turn_ended", usage: {} },
      ],
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }),
    );
    await waitForStream(stream);
    const done = stream.events.find((event) => event.type === "done");
    const thinking =
      done?.type === "done"
        ? done.message.content
            .filter((block) => block.type === "thinking")
            .map((block) => (block.type === "thinking" ? block.thinking : ""))
            .join("")
        : "";
    const text =
      done?.type === "done"
        ? done.message.content
            .filter((block) => block.type === "text")
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
        : "";
    expect(thinking).toBe("plan");
    expect(text).toBe("hello");
  });

  it("advertised mcp_args yields matching toolCall, toolUse, MCP reply, and cancel", async () => {
    withKey();
    const { epoch, runs } = fakeEpoch({
      events: [
        {
          type: "mcp_exec",
          id: 1,
          execId: "exec-1",
          name: "read_file",
          argumentsJson: JSON.stringify({ path: "README.md" }),
          toolCallId: "call-1",
        },
      ],
    });
    const stream = asTestStream(
      streamCursor(
        epoch,
        TEST_MODEL,
        {
          messages: [{ role: "user", content: "read it" }],
          tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
        },
      ),
    );
    await waitForStream(stream);
    const done = stream.events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.reason : undefined).toBe("toolUse");
    const tool = done?.type === "done" ? done.message.content.find((block) => block.type === "toolCall") : undefined;
    expect(tool).toMatchObject({ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "README.md" } });
    expect(stream.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["toolcall_start", "toolcall_delta", "toolcall_end", "done"]),
    );
    const reply = runs[0]?.replies[0] as {
      message?: { case?: string; value?: { id?: number; execId?: string; message?: { case?: string } } };
    };
    expect(reply.message?.case).toBe("execClientMessage");
    expect(reply.message?.value?.id).toBe(1);
    expect(reply.message?.value?.execId).toBe("exec-1");
    expect(reply.message?.value?.message?.case).toBe("mcpResult");
    expect(runs[0]?.abortCount).toBeGreaterThan(0);
    expect(runs[0]?.options.mode).toBe("agent");
    expect(runs[0]?.options.mcpTools?.map((tool) => tool.name)).toEqual(["read_file"]);
  });

  it("second streamSimple after a tool result uses new ids and serializes tool history", async () => {
    withKey();
    const { epoch, runs } = fakeEpoch({
      events: [{ type: "text_delta", text: "done" }, { type: "turn_ended", usage: {} }],
    });
    const first = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "read" }] }),
    );
    await waitForStream(first);
    const second = asTestStream(
      streamCursor(epoch, TEST_MODEL, {
        systemPrompt: "be brief",
        messages: [
          { role: "user", content: "read" },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
            api: TEST_MODEL.api,
            provider: TEST_MODEL.provider,
            model: TEST_MODEL.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read_file",
            content: [{ type: "text", text: "file body" }],
          },
          { role: "user", content: "summarize" },
        ],
      }),
    );
    await waitForStream(second);
    expect(runs).toHaveLength(2);
    expect(runs[1]?.options.conversationId).not.toBe(runs[0]?.options.conversationId);
    expect(runs[1]?.options.runId).not.toBe(runs[0]?.options.runId);
    const history = runs[1]?.options.conversationHistory;
    const toolMessage = history?.messages.find((message) => message.message.case === "tool");
    expect(toolMessage?.message.case).toBe("tool");
    if (toolMessage?.message.case === "tool") {
      expect(toolMessage.message.value.toolCallId).toBe("call-1");
      expect(toolMessage.message.value.toolName).toBe("read_file");
    }
    const encoded = JSON.stringify(history);
    expect(encoded).toContain("file body");
    expect(encoded).not.toContain("checkpoint");
    expect(encoded).not.toContain("conversationStateBlob");
    expect(encoded).not.toMatch(/fileContents":\{"[^"]/);
    expect(runs[1]?.options.customSystemPrompt).toBe("be brief");
  });

  it("two advertised mcp_args in one burst both become Pi tool calls before cancel", async () => {
    withKey();
    const { epoch, runs } = fakeEpoch({
      events: [
        {
          type: "mcp_exec",
          id: 1,
          execId: "a",
          name: "read_file",
          argumentsJson: JSON.stringify({ path: "a.ts" }),
        },
        {
          type: "mcp_exec",
          id: 2,
          execId: "b",
          name: "grep",
          argumentsJson: JSON.stringify({ pattern: "foo" }),
        },
      ],
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, {
        messages: [{ role: "user", content: "search" }],
        tools: [
          { name: "read_file", description: "Read" },
          { name: "grep", description: "Search" },
        ],
      }),
    );
    await waitForStream(stream);
    const done = stream.events.find((event) => event.type === "done");
    const calls =
      done?.type === "done" ? done.message.content.filter((block) => block.type === "toolCall") : [];
    expect(calls.map((block) => (block.type === "toolCall" ? block.name : undefined))).toEqual(["read_file", "grep"]);
    expect(runs[0]?.replies).toHaveLength(2);
    expect(runs[0]?.abortCount).toBeGreaterThan(0);
  });

  it("unadvertised mcp_args is not a Pi toolCall but still replies and cancels", async () => {
    withKey();
    const { epoch, runs } = fakeEpoch({
      events: [
        {
          type: "mcp_exec",
          id: 9,
          execId: "x",
          name: "shell",
          argumentsJson: JSON.stringify({ command: "ls" }),
        },
        { type: "turn_ended", usage: {} },
      ],
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read_file", description: "Read" }],
      }),
    );
    await waitForStream(stream);
    const done = stream.events.find((event) => event.type === "done");
    expect(done?.type === "done" ? done.reason : undefined).toBe("stop");
    expect(done?.type === "done" ? done.message.content.filter((block) => block.type === "toolCall") : []).toEqual([]);
    const reply = runs[0]?.replies[0] as { message?: { value?: { message?: { case?: string } } } };
    expect(reply.message?.value?.message?.case).toBe("mcpResult");
    expect(runs[0]?.replies).toHaveLength(1);
    expect(runs[0]?.abortCount).toBeGreaterThan(0);
  });

  it("tool-capable run options do not send workspace contents on the public run API", async () => {
    withKey();
    const { epoch, runs } = fakeEpoch({ events: [{ type: "turn_ended", usage: {} }] });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read_file", description: "Read" }],
      }),
    );
    await waitForStream(stream);
    expect(runs[0]?.options.mode).toBe("agent");
    expect(runs[0]?.options).not.toHaveProperty("workspace_paths");
    expect(runs[0]?.options).not.toHaveProperty("file_contents");
    expect(JSON.stringify(runs[0]?.options)).not.toContain("file_contents");
  });

  it("is_server_notice is not concatenated into assistant text", async () => {
    withKey();
    const { epoch } = fakeEpoch({
      events: [
        { type: "server_notice", text: "notice" },
        { type: "text_delta", text: "visible" },
        { type: "turn_ended", usage: {} },
      ],
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }),
    );
    await waitForStream(stream);
    const done = stream.events.find((event) => event.type === "done");
    const text =
      done?.type === "done"
        ? done.message.content
            .filter((block) => block.type === "text")
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("")
        : "";
    expect(text).toBe("visible");
    expect(text).not.toContain("notice");
  });

  it("inbound interaction_query rejects and the stream still ends", async () => {
    withKey();
    const { epoch } = fakeEpoch({
      events: [{ type: "text_delta", text: "partial" }],
      error: new StreamError("interaction query rejected"),
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }),
    );
    await waitForStream(stream);
    expect(stream.events.some((event) => event.type === "error")).toBe(true);
  });

  it("unimplemented shell exec does not become a Pi tool", async () => {
    withKey();
    const { epoch } = fakeEpoch({
      error: new StreamError("unimplemented exec"),
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read_file", description: "Read" }],
      }),
    );
    await waitForStream(stream);
    const error = stream.events.find((event) => event.type === "error");
    expect(error?.type === "error" ? error.error.content.filter((block) => block.type === "toolCall") : []).toEqual([]);
  });

  it("streamSimple does not throw when run raises TransportUnsupportedError", async () => {
    withKey();
    const { epoch } = fakeEpoch({
      runImpl: async () => {
        throw new TransportUnsupportedError("HTTP/1.1 not supported");
      },
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }),
    );
    await waitForStream(stream);
    const error = stream.events.find((event) => event.type === "error");
    expect(error?.type === "error" ? error.error.stopReason : undefined).toBe("error");
    expect(error?.type === "error" ? error.error.errorMessage : undefined).toMatch(/HTTP\/1\.1/i);
  });

  it("forwards maxTokens onto the Cursor Run", async () => {
    withKey();
    const { epoch, runs } = fakeEpoch({ events: [{ type: "turn_ended", usage: {} }] });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, { messages: [{ role: "user", content: "hi" }] }, { maxTokens: 128 }),
    );
    await waitForStream(stream);
    expect(runs[0]?.options.maxTokens).toBe(128);
    expect(runs[0]?.options.modelId).toBe(TEST_MODEL.id);
  });

  it("adapter events do not contain scripted tool-arg payloads in error text", async () => {
    withKey();
    const secretArg = "super-secret-tool-arg";
    const { epoch } = fakeEpoch({
      events: [
        {
          type: "mcp_exec",
          id: 1,
          execId: "exec-1",
          name: "read_file",
          argumentsJson: JSON.stringify({ path: secretArg }),
        },
      ],
    });
    const stream = asTestStream(
      streamCursor(epoch, TEST_MODEL, {
        messages: [{ role: "user", content: "read" }],
        tools: [{ name: "read_file", description: "Read" }],
      }),
    );
    await waitForStream(stream);
    const serialized = JSON.stringify(stream.events.filter((event) => event.type === "error"));
    expect(serialized).not.toContain(secretArg);
  });
});
