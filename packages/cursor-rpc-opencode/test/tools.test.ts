import { create } from "@bufbuild/protobuf";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  createClient,
  type AgentClientMessage,
  type ClientRunOptions,
  type ConversationHistory,
  type CursorRpcClient,
  type RunEvent,
  type RunHandle,
} from "cursor-rpc";
import { describe, expect, it, vi } from "vitest";
import { PrivacyMode, GetUserPrivacyModeResponseSchema } from "../../cursor-rpc/src/generated/aiserver/v1/dashboard_pb.ts";
import {
  AvailableModelsResponseSchema,
  GetDefaultModelForCliResponseSchema,
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../../cursor-rpc/src/generated/aiserver/v1/models_pb.ts";
import { GetServerConfigResponseSchema, Http2Config } from "../../cursor-rpc/src/generated/aiserver/v1/server_config_pb.ts";
import {
  AgentMode,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  McpAuthRequestQuerySchema,
  McpArgsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  type AgentServerMessage,
} from "../../cursor-rpc/src/generated/agent/v1/agent_pb.ts";
import type { BootstrapClients } from "../../cursor-rpc/src/session/bootstrap.ts";
import { TOOLS_SUPPORTED, CursorLanguageModel } from "../src/language-model.ts";
import { streamCursorRun } from "../src/stream.ts";

const MODEL = create(ModelDetailsSchema, { modelId: "composer-2.5", displayName: "Composer" });

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    contents: { type: "string" },
  },
  required: ["path", "contents"],
} as const;

const WRITE_ARGS = { path: "README.md", contents: "hi" };
const WRITE_ARGS_JSON = JSON.stringify(WRITE_ARGS);

const WRITE_TOOL = {
  type: "function" as const,
  name: "write",
  description: "Write a file",
  inputSchema: WRITE_SCHEMA,
};

function user(text: string): LanguageModelV3CallOptions["prompt"][number] {
  return { role: "user", content: [{ type: "text", text }] };
}

function emptyHistory(): ConversationHistory {
  return { messages: [] } as ConversationHistory;
}

function completedHandle(
  events: RunEvent[],
  extras: { abort?: () => void; conversationHistory?: () => ConversationHistory } = {},
): RunHandle {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    wait: async () => ({
      text: events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""),
      usage: events.find((event) => event.type === "turn_ended")?.usage ?? {},
      events,
    }),
    abort: extras.abort ?? (() => undefined),
    conversationHistory: extras.conversationHistory ?? emptyHistory,
  };
}

function modelWithRun(
  run: (options: ClientRunOptions) => Promise<RunHandle>,
): CursorLanguageModel {
  const client = { close: () => undefined, run } as CursorRpcClient;
  return new CursorLanguageModel({
    provider: "cursor-rpc",
    modelId: "composer",
    getClient: () => client,
  });
}

async function collectParts(stream: ReadableStream<LanguageModelV3StreamPart>): Promise<{
  parts: LanguageModelV3StreamPart[];
  error: unknown;
}> {
  const parts: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parts.push(value);
    }
    return { parts, error: undefined };
  } catch (error) {
    return { parts, error };
  }
}

function finishes(parts: LanguageModelV3StreamPart[]): Array<Extract<LanguageModelV3StreamPart, { type: "finish" }>> {
  return parts.filter((part) => part.type === "finish");
}

function toolCalls(parts: LanguageModelV3StreamPart[]): Array<Extract<LanguageModelV3StreamPart, { type: "tool-call" }>> {
  return parts.filter((part) => part.type === "tool-call");
}

function historyRole(message: ConversationHistory["messages"][number]): string | undefined {
  return message.message.case;
}

function assistantToolCalls(message: ConversationHistory["messages"][number] | undefined) {
  if (message?.message.case !== "assistant") {
    return [];
  }
  return message.message.value.content
    .filter((part) => part.content.case === "toolCall")
    .map((part) => (part.content.case === "toolCall" ? part.content.value : undefined));
}

function toolMessage(message: ConversationHistory["messages"][number] | undefined) {
  return message?.message.case === "tool" ? message.message.value : undefined;
}

function bootstrapClients(overrides: Partial<BootstrapClients> = {}): BootstrapClients {
  return {
    getServerConfig: async () =>
      create(GetServerConfigResponseSchema, {
        http2Config: Http2Config.FORCE_ALL_ENABLED,
      }),
    getUserPrivacyMode: async () => create(GetUserPrivacyModeResponseSchema, { privacyMode: PrivacyMode.NO_TRAINING }),
    getUsableModels: async () => create(GetUsableModelsResponseSchema, { models: [MODEL] }),
    getDefaultModelForCli: async () => create(GetDefaultModelForCliResponseSchema, { model: MODEL }),
    availableModels: async () => create(AvailableModelsResponseSchema, { models: [] }),
    ...overrides,
  };
}

function testClient(options: {
  openRun?: NonNullable<Parameters<typeof createClient>[0]["openRun"]>;
}): CursorRpcClient {
  return createClient({
    apiKey: "key_tools_test",
    env: {},
    fetch: async () =>
      new Response(JSON.stringify({ accessToken: "tok", refreshToken: "ref" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    bootstrapClients: bootstrapClients(),
    openRun: options.openRun,
  });
}

function textDelta(text: string): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "textDelta",
          value: create(TextDeltaUpdateSchema, { text }),
        },
      }),
    },
  });
}

function turnEnded(): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, { inputTokens: 1, outputTokens: 2 }) },
      }),
    },
  });
}

function mcpAuthQuery(): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionQuery",
      value: create(InteractionQuerySchema, {
        id: 9,
        query: { case: "mcpAuthRequestQuery", value: create(McpAuthRequestQuerySchema, {}) },
      }),
    },
  });
}

function mcpArgsMessage(toolName: string, argsJson: string, id = 11): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id,
        execId: `exec-${toolName}`,
        message: {
          case: "mcpArgs",
          value: create(McpArgsSchema, {
            name: toolName,
            toolName,
            argsJson,
            providerIdentifier: "opencode",
          }),
        },
      }),
    },
  });
}

function unknownExecMessage(): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 7,
        execId: "exec-shell",
      }),
    },
  });
}

function requestContextArgs(): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 6,
        execId: "exec-context",
        message: { case: "requestContextArgs", value: {} },
      }),
    },
  });
}

describe("OpenCode tools through Cursor MCP", () => {
  it("exposes a factory-level tools-supported signal", () => {
    expect(TOOLS_SUPPORTED).toBe(true);
  });

  it("advertises write (and a second tool 1:1) as mcp_tools with opencode provider", async () => {
    let captured: ClientRunOptions | undefined;
    const model = modelWithRun(async (options) => {
      captured = options;
      return completedHandle([{ type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } }]);
    });

    await model.doStream({
      prompt: [user("write a file")],
      tools: [
        WRITE_TOOL,
        { type: "function", name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      ],
    });

    expect(captured?.mode).toBeUndefined();
    expect(captured?.handlers).toBeUndefined();
    expect(captured?.handlers?.onExec).toBeUndefined();
    const tools = captured?.mcpTools ?? [];
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("write");
    expect(tools[0]?.toolName).toBe("write");
    expect(tools[0]?.providerIdentifier).toBe("opencode");
    expect(JSON.parse(tools[0]?.inputSchemaJson ?? "{}")).toEqual(WRITE_SCHEMA);
    expect(tools[1]?.name).toBe("read");
    expect(tools[1]?.toolName).toBe("read");
    expect(tools[1]?.providerIdentifier).toBe("opencode");
  });

  it("maps advertised mcp_args to a V3 tool-call, finishes tool-calls, and aborts without a V3 error", async () => {
    let aborted = false;
    const model = modelWithRun(async () =>
      completedHandle(
        [
          {
            type: "mcp_args",
            toolName: "write",
            argsJson: WRITE_ARGS_JSON,
            id: 11,
            execId: "exec-mcp-1",
          },
          { type: "text_delta", text: "should not map" },
          { type: "turn_ended", usage: { inputTokens: 2, outputTokens: 2 } },
        ],
        {
          abort: () => {
            aborted = true;
          },
        },
      ),
    );

    const { stream } = await model.doStream({
      prompt: [user("write README")],
      tools: [WRITE_TOOL],
    });
    const collected = await collectParts(stream);

    expect(collected.error).toBeUndefined();
    expect(collected.parts.some((part) => part.type === "error")).toBe(false);
    expect(collected.parts.some((part) => part.type === "text-delta")).toBe(false);
    expect(aborted).toBe(true);

    const calls = toolCalls(collected.parts);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("write");
    expect(calls[0]?.input).toBe(WRITE_ARGS_JSON);
    expect(calls[0]?.toolCallId).toEqual(expect.any(String));
    expect(calls[0]?.toolCallId).not.toBe("11");
    expect(calls[0]?.toolCallId).not.toBe("exec-mcp-1");

    const id = calls[0]?.toolCallId;
    expect(collected.parts).toEqual(
      expect.arrayContaining([
        { type: "tool-input-start", id, toolName: "write" },
        { type: "tool-input-delta", id, delta: WRITE_ARGS_JSON },
        { type: "tool-input-end", id },
        { type: "tool-call", toolCallId: id, toolName: "write", input: WRITE_ARGS_JSON },
      ]),
    );

    const finish = finishes(collected.parts);
    expect(finish).toHaveLength(1);
    expect(finish[0]?.finishReason).toEqual({ unified: "tool-calls", raw: "mcp_args" });
  });

  it("does not set onExec and still throws Cursor non-MCP exec with no shell result", async () => {
    const outbound: AgentClientMessage[] = [];
    const client = testClient({
      openRun: async function* (messages) {
        const iterator = messages[Symbol.asyncIterator]();
        const opening = await iterator.next();
        if (opening.value !== undefined) {
          outbound.push(opening.value);
        }
        yield unknownExecMessage();
        const reply = await Promise.race([
          iterator.next(),
          new Promise<IteratorResult<AgentClientMessage>>((resolve) => {
            setTimeout(() => resolve({ done: true, value: undefined }), 1500);
          }),
        ]);
        if (reply.value !== undefined) {
          outbound.push(reply.value);
        }
        yield requestContextArgs();
        const contextReply = await Promise.race([
          iterator.next(),
          new Promise<IteratorResult<AgentClientMessage>>((resolve) => {
            setTimeout(() => resolve({ done: true, value: undefined }), 1500);
          }),
        ]);
        if (contextReply.value !== undefined) {
          outbound.push(contextReply.value);
        }
        yield textDelta("ok");
        yield turnEnded();
      },
    });
    const model = new CursorLanguageModel({
      provider: "cursor-rpc",
      modelId: "composer",
      getClient: () => client,
    });

    const { stream } = await model.doStream({
      prompt: [user("hi")],
      tools: [WRITE_TOOL],
    });
    const collected = await Promise.race([
      collectParts(stream),
      new Promise<{ parts: LanguageModelV3StreamPart[]; error: unknown }>((resolve) => {
        setTimeout(() => resolve({ parts: [], error: new Error("hung") }), 2000);
      }),
    ]);

    expect(String(collected.error)).not.toBe("hung");
    expect(toolCalls(collected.parts)).toHaveLength(0);
    const throws = outbound.filter((message) => message.message.case === "execClientControlMessage");
    expect(throws.length).toBeGreaterThan(0);
    expect(
      throws.every((message) => {
        if (message.message.case !== "execClientControlMessage") {
          return false;
        }
        return message.message.value.message.case === "throw";
      }),
    ).toBe(true);
    const context = outbound.find((message) => message.message.case === "execClientMessage");
    if (context?.message.case === "execClientMessage" && context.message.value.message.case === "requestContextResult") {
      expect(context.message.value.message.value.requestContext?.env?.workspacePaths).toEqual([]);
    }
    expect(JSON.stringify(outbound)).not.toMatch(/mcpResult|mcp_result|shellResult|shell_result/);
    client.close();
  });

  it("follow-up doStream starts a new Run with OpenCode tool history and discards the aborted transcript", async () => {
    const runs: ClientRunOptions[] = [];
    let firstAbort = 0;
    let abortedHistoryReads = 0;
    const poisoned = {
      messages: [
        {
          message: {
            case: "assistant" as const,
            value: { content: [{ content: { case: "text" as const, value: { text: "tool not implemented" } } }] },
          },
        },
      ],
    } as ConversationHistory;

    const model = modelWithRun(async (options) => {
      runs.push(options);
      if (runs.length === 1) {
        return completedHandle(
          [{ type: "mcp_args", toolName: "write", argsJson: WRITE_ARGS_JSON, id: 11, execId: "exec-1" }],
          {
            abort: () => {
              firstAbort += 1;
            },
            conversationHistory: () => {
              abortedHistoryReads += 1;
              return poisoned;
            },
          },
        );
      }
      return completedHandle([{ type: "text_delta", text: "done" }, { type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } }]);
    });

    const first = await model.doStream({ prompt: [user("write README")], tools: [WRITE_TOOL] });
    const firstParts = await collectParts(first.stream);
    const toolCallId = toolCalls(firstParts.parts)[0]?.toolCallId;
    expect(toolCallId).toEqual(expect.any(String));
    expect(firstAbort).toBe(1);

    const second = await model.doStream({
      prompt: [
        user("write README"),
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: toolCallId ?? "missing", toolName: "write", input: WRITE_ARGS }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: toolCallId ?? "missing",
              toolName: "write",
              output: { type: "text", value: "wrote README.md" },
            },
          ],
        },
        user("thanks"),
      ],
      tools: [WRITE_TOOL],
    });
    await collectParts(second.stream);

    expect(runs).toHaveLength(2);
    expect(runs[1]?.prompt).toBe("thanks");
    expect(runs[0]).not.toBe(runs[1]);
    expect(JSON.stringify(runs[1])).not.toMatch(/mcpResult|mcp_result/);
    expect(JSON.stringify(runs[1]?.conversationHistory)).not.toContain("tool not implemented");
    expect(abortedHistoryReads).toBe(0);

    const history = runs[1]?.conversationHistory?.messages ?? [];
    const assistant = history.find((message) => historyRole(message) === "assistant");
    const tool = history.find((message) => historyRole(message) === "tool");
    const calls = assistantToolCalls(assistant);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolCallId).toBe(toolCallId);
    expect(calls[0]?.toolName).toBe("write");
    expect(calls[0]?.argsJson).toBe(WRITE_ARGS_JSON);
    expect(toolMessage(tool)?.toolCallId).toBe(toolCallId);
    expect(toolMessage(tool)?.toolName).toBe("write");
    expect(toolMessage(tool)?.content.some((part) => part.content.case === "text" && part.content.value.text === "wrote README.md")).toBe(
      true,
    );
  });

  it("does not send mcp_tools when tools is empty", async () => {
    let captured: ClientRunOptions | undefined;
    const model = modelWithRun(async (options) => {
      captured = options;
      return completedHandle([{ type: "turn_ended", usage: {} }]);
    });

    await model.doStream({ prompt: [user("hi")], tools: [] });

    expect(captured?.mcpTools === undefined || captured?.mcpTools.length === 0).toBe(true);
  });

  it("does not map display-only Cursor tool_call events to V3 tool-call parts", async () => {
    const model = modelWithRun(async () =>
      completedHandle([
        { type: "text_delta", text: "hi" },
        { type: "tool_call", callId: "display-1", toolCallId: "tc1", phase: "started" },
        { type: "tool_call", callId: "display-1", toolCallId: "tc1", phase: "completed" },
        { type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    );

    const { stream } = await model.doStream({ prompt: [user("hi")], tools: [WRITE_TOOL] });
    const { parts } = await collectParts(stream);

    expect(parts.some((part) => part.type === "tool-call" || part.type === "tool-input-start")).toBe(false);
    expect(finishes(parts)).toHaveLength(1);
  });

  it("aborts unadvertised mcp_args with no V3 tool-call and does not hang", async () => {
    let aborted = false;
    const model = modelWithRun(async () =>
      completedHandle(
        [{ type: "mcp_args", toolName: "bash", argsJson: '{"command":"ls"}', id: 99, execId: "exec-bash" }],
        {
          abort: () => {
            aborted = true;
          },
        },
      ),
    );

    const outcome = await Promise.race([
      model
        .doStream({ prompt: [user("hi")], tools: [WRITE_TOOL] })
        .then(async (result) => collectParts(result.stream))
        .then((collected) => ({ kind: "done" as const, collected })),
      new Promise<{ kind: "hang" }>((resolve) => {
        setTimeout(() => resolve({ kind: "hang" }), 1500);
      }),
    ]);

    expect(outcome.kind).not.toBe("hang");
    if (outcome.kind !== "done") {
      return;
    }
    expect(aborted).toBe(true);
    expect(outcome.collected.error).toBeDefined();
    expect(toolCalls(outcome.collected.parts)).toHaveLength(0);
    expect(outcome.collected.parts.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(finishes(outcome.collected.parts)).toHaveLength(0);
  });

  it("rejects mcp_args from a foreign provider_identifier even when the name is advertised", async () => {
    let aborted = false;
    const model = modelWithRun(async () =>
      completedHandle(
        [
          {
            type: "mcp_args",
            toolName: "write",
            argsJson: WRITE_ARGS_JSON,
            id: 99,
            execId: "exec-write",
            providerIdentifier: "cursor",
          },
        ],
        {
          abort: () => {
            aborted = true;
          },
        },
      ),
    );

    const { stream } = await model.doStream({ prompt: [user("hi")], tools: [WRITE_TOOL] });
    const collected = await collectParts(stream);

    expect(aborted).toBe(true);
    expect(collected.error).toBeDefined();
    expect(toolCalls(collected.parts)).toHaveLength(0);
    expect(finishes(collected.parts)).toHaveLength(0);
  });

  it("AGENT probe via streamCursorRun mode does not apply a shell result and shipped doStream stays ASK", async () => {
    const outbound: AgentClientMessage[] = [];
    const client = testClient({
      openRun: async function* (messages) {
        const iterator = messages[Symbol.asyncIterator]();
        const opening = await iterator.next();
        if (opening.value !== undefined) {
          outbound.push(opening.value);
        }
        yield unknownExecMessage();
        const shellReply = await Promise.race([
          iterator.next(),
          new Promise<IteratorResult<AgentClientMessage>>((resolve) => {
            setTimeout(() => resolve({ done: true, value: undefined }), 1500);
          }),
        ]);
        if (shellReply.value !== undefined) {
          outbound.push(shellReply.value);
        }
        yield mcpArgsMessage("write", WRITE_ARGS_JSON);
        const mcpReply = await Promise.race([
          iterator.next(),
          new Promise<IteratorResult<AgentClientMessage>>((resolve) => {
            setTimeout(() => resolve({ done: true, value: undefined }), 1500);
          }),
        ]);
        if (mcpReply.value !== undefined) {
          outbound.push(mcpReply.value);
        }
      },
    });

    const probe = await Promise.race([
      streamCursorRun({
        client,
        modelId: "composer",
        call: { prompt: [user("write README")], tools: [WRITE_TOOL] },
        mode: "agent",
      }).then(async (result) => collectParts(result.stream)),
      new Promise<{ parts: LanguageModelV3StreamPart[]; error: unknown }>((resolve) => {
        setTimeout(() => resolve({ parts: [], error: new Error("hung") }), 2000);
      }),
    ]);

    expect(String(probe.error)).not.toBe("hung");
    expect(probe.error).toBeUndefined();
    expect(probe.parts.some((part) => part.type === "error")).toBe(false);
    const calls = toolCalls(probe.parts);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("write");
    expect(calls[0]?.input).toBe(WRITE_ARGS_JSON);
    expect(finishes(probe.parts)[0]?.finishReason.unified).toBe("tool-calls");

    const opening = outbound.find((message) => message.message.case === "runRequest");
    expect(opening?.message.case).toBe("runRequest");
    if (opening?.message.case === "runRequest") {
      const action = opening.message.value.action?.action;
      expect(action?.case).toBe("userMessageAction");
      if (action?.case === "userMessageAction") {
        expect(action.value.userMessage?.mode).toBe(AgentMode.AGENT);
        expect(action.value.requestContext?.env?.workspacePaths).toEqual([]);
      }
    }
    expect(
      outbound.some(
        (message) =>
          message.message.case === "execClientControlMessage" && message.message.value.message.case === "throw",
      ),
    ).toBe(true);
    expect(JSON.stringify(outbound)).not.toMatch(/mcpResult|mcp_result|shellResult|shell_result/);

    let shipped: ClientRunOptions | undefined;
    const shippedModel = modelWithRun(async (options) => {
      shipped = options;
      return completedHandle([{ type: "turn_ended", usage: {} }]);
    });
    await shippedModel.doStream({ prompt: [user("hi")], tools: [WRITE_TOOL] });
    expect(shipped?.mode).toBeUndefined();
    client.close();
  });

  it("rejects mcp_auth_request_query on a tool-mapped ASK turn without a V3 tool-call or login()", async () => {
    const loginSpy = vi.spyOn(await import("cursor-rpc"), "login");
    const outbound: AgentClientMessage[] = [];
    const client = testClient({
      openRun: async function* (messages) {
        const iterator = messages[Symbol.asyncIterator]();
        const opening = await iterator.next();
        if (opening.value !== undefined) {
          outbound.push(opening.value);
        }
        yield mcpAuthQuery();
        const reply = await Promise.race([
          iterator.next(),
          new Promise<IteratorResult<AgentClientMessage>>((resolve) => {
            setTimeout(() => resolve({ done: true, value: undefined }), 1500);
          }),
        ]);
        if (reply.value !== undefined) {
          outbound.push(reply.value);
        }
        yield textDelta("ok");
        yield turnEnded();
      },
    });
    const model = new CursorLanguageModel({
      provider: "cursor-rpc",
      modelId: "composer",
      getClient: () => client,
    });

    const collected = await Promise.race([
      model
        .doStream({ prompt: [user("auth?")], tools: [WRITE_TOOL] })
        .then(async (result) => collectParts(result.stream)),
      new Promise<{ parts: LanguageModelV3StreamPart[]; error: unknown }>((resolve) => {
        setTimeout(() => resolve({ parts: [], error: new Error("hung") }), 2000);
      }),
    ]);

    expect(String(collected.error)).not.toBe("hung");
    expect(collected.error).toBeUndefined();
    expect(toolCalls(collected.parts)).toHaveLength(0);
    expect(loginSpy).not.toHaveBeenCalled();
    const response = outbound.find((message) => message.message.case === "interactionResponse");
    expect(response?.message.case).toBe("interactionResponse");
    if (response?.message.case === "interactionResponse") {
      expect(response.message.value.result.case).toBe("mcpAuthRequestResponse");
      const result = response.message.value.result;
      if (result.case === "mcpAuthRequestResponse") {
        expect(result.value.result.case).toBe("rejected");
      }
    }
    if (outbound[0]?.message.case === "runRequest") {
      const action = outbound[0].message.value.action?.action;
      if (action?.case === "userMessageAction") {
        expect(action.value.userMessage?.mode).toBe(AgentMode.ASK);
      }
    }
    client.close();
    loginSpy.mockRestore();
  });
});
