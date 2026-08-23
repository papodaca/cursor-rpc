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
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  type AgentServerMessage,
} from "../../cursor-rpc/src/generated/agent/v1/agent_pb.ts";
import type { BootstrapClients } from "../../cursor-rpc/src/session/bootstrap.ts";
import { CursorLanguageModel, toolsSupported } from "../src/language-model.ts";

const WRITE_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    contents: { type: "string" },
  },
  required: ["path", "contents"],
} as const;

const READ_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
  },
  required: ["path"],
} as const;

const WRITE_ARGS = { path: "README.md", contents: "hi" };
const WRITE_ARGS_JSON = JSON.stringify(WRITE_ARGS);
const MODEL = create(ModelDetailsSchema, { modelId: "composer-2.5", displayName: "Composer" });

function user(text: string): LanguageModelV3CallOptions["prompt"][number] {
  return { role: "user", content: [{ type: "text", text }] };
}

function writeTool(): NonNullable<LanguageModelV3CallOptions["tools"]>[number] {
  return { type: "function", name: "write", description: "Write a file", inputSchema: WRITE_SCHEMA };
}

function emptyHistory(): ConversationHistory {
  return { messages: [] } as ConversationHistory;
}

function completedHandle(
  events: RunEvent[],
  extras: { abort?: () => void; conversationHistory?: RunHandle["conversationHistory"] } = {},
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
  close: () => void = () => undefined,
): CursorLanguageModel {
  const client = { close, run } as CursorRpcClient;
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

function streamWarnings(parts: LanguageModelV3StreamPart[]) {
  return parts
    .filter((part): part is Extract<LanguageModelV3StreamPart, { type: "stream-start" }> => part.type === "stream-start")
    .flatMap((part) => part.warnings);
}

function historyToolCalls(history: ConversationHistory | undefined) {
  const calls: Array<{ toolCallId: string; toolName: string; argsJson: string }> = [];
  for (const message of history?.messages ?? []) {
    if (message.message.case !== "assistant") {
      continue;
    }
    for (const part of message.message.value.content) {
      if (part.content.case === "toolCall") {
        calls.push(part.content.value);
      }
    }
  }
  return calls;
}

function historyToolMessages(history: ConversationHistory | undefined) {
  return (history?.messages ?? [])
    .filter((message) => message.message.case === "tool")
    .map((message) => (message.message.case === "tool" ? message.message.value : undefined))
    .filter((value): value is NonNullable<typeof value> => value !== undefined);
}

function historyTexts(history: ConversationHistory | undefined): string[] {
  const texts: string[] = [];
  for (const message of history?.messages ?? []) {
    if (message.message.case === "user" || message.message.case === "assistant") {
      for (const part of message.message.value.content) {
        if (part.content.case === "text") {
          texts.push(part.content.value.text);
        }
      }
    }
    if (message.message.case === "tool") {
      for (const part of message.message.value.content) {
        if (part.content.case === "text") {
          texts.push(part.content.value.text);
        }
      }
    }
  }
  return texts;
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

function wrapClient(real: CursorRpcClient): {
  client: CursorRpcClient;
  captured: () => ClientRunOptions | undefined;
} {
  let captured: ClientRunOptions | undefined;
  return {
    client: {
      close: () => real.close(),
      models: (signal) => real.models(signal),
      run: async (options) => {
        captured = options;
        return real.run(options);
      },
    },
    captured: () => captured,
  };
}

function openingRequest(message: AgentClientMessage | undefined) {
  if (message?.message.case !== "runRequest") {
    return undefined;
  }
  return message.message.value;
}

function userMessageAction(message: AgentClientMessage | undefined) {
  const request = openingRequest(message);
  const action = request?.action?.action;
  if (action?.case !== "userMessageAction") {
    return undefined;
  }
  return action.value;
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
        message: {
          case: "turnEnded",
          value: create(TurnEndedUpdateSchema, { inputTokens: 1, outputTokens: 1 }),
        },
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

function requestContextArgs(): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 6,
        execId: "exec-6",
        message: { case: "requestContextArgs", value: {} },
      }),
    },
  });
}

function unknownExec(): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, { id: 4, execId: "exec-shell" }),
    },
  });
}

async function withTimeout<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("hung")), ms);
    }),
  ]);
}

describe("OpenCode tools through Cursor MCP", () => {
  it("exposes a factory-level tools-supported signal", () => {
    expect(toolsSupported).toBe(true);
  });

  it("advertises OpenCode write as mcp_tools per KTD5 and two tools 1:1", async () => {
    let captured: ClientRunOptions | undefined;
    const model = modelWithRun(async (options) => {
      captured = options;
      return completedHandle([{ type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } }]);
    });

    await model.doStream({
      prompt: [user("write a file")],
      tools: [
        writeTool(),
        { type: "function", name: "read", description: "Read a file", inputSchema: READ_SCHEMA },
      ],
    });

    expect(captured?.mode === "ask" || captured?.mode === undefined).toBe(true);
    expect(captured?.handlers).toBeUndefined();
    expect(captured?.handlers?.onExec).toBeUndefined();
    const tools = captured?.mcpTools ?? [];
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("write");
    expect(tools[0]?.toolName).toBe("write");
    expect(tools[0]?.providerIdentifier).toBe("opencode");
    expect(JSON.parse(tools[0]?.inputSchemaJson ?? "null")).toEqual(WRITE_SCHEMA);
    expect(tools[1]?.name).toBe("read");
    expect(tools[1]?.toolName).toBe("read");
    expect(tools[1]?.providerIdentifier).toBe("opencode");
    expect(JSON.parse(tools[1]?.inputSchemaJson ?? "null")).toEqual(READ_SCHEMA);
    expect(JSON.stringify(captured)).not.toMatch(/mcp_result|mcpResult/);
  });

  it("omits mcp_tools when tools is empty", async () => {
    let captured: ClientRunOptions | undefined;
    const model = modelWithRun(async (options) => {
      captured = options;
      return completedHandle([{ type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } }]);
    });

    await model.doStream({ prompt: [user("hi")], tools: [] });

    expect(captured?.mcpTools === undefined || captured?.mcpTools.length === 0).toBe(true);
  });

  it("maps advertised mcp_args to a V3 tool-call, finishes tool-calls, aborts the Run, and ignores later text", async () => {
    let aborted = false;
    const conversationHistory = vi.fn(() => ({
      messages: [
        {
          message: {
            case: "assistant" as const,
            value: { content: [{ content: { case: "text" as const, value: { text: "tool not implemented" } } }] },
          },
        },
      ],
    }) as ConversationHistory);
    const model = modelWithRun(async () =>
      completedHandle(
        [
          { type: "mcp_args", toolName: "write", argsJson: WRITE_ARGS_JSON, id: 11, execId: "exec-mcp-1" },
          { type: "text_delta", text: "should-not-appear" },
          { type: "turn_ended", usage: { inputTokens: 2, outputTokens: 3 } },
        ],
        {
          abort: () => {
            aborted = true;
          },
          conversationHistory,
        },
      ),
    );

    const collected = await withTimeout(
      model
        .doStream({ prompt: [user("write a file")], tools: [writeTool()] })
        .then(async (result) => collectParts(result.stream)),
    );

    expect(collected.error).toBeUndefined();
    expect(collected.parts.some((part) => part.type === "error")).toBe(false);
    const calls = toolCalls(collected.parts);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("write");
    expect(calls[0]?.input).toBe(WRITE_ARGS_JSON);
    expect(typeof calls[0]?.input).toBe("string");
    expect(calls[0]?.toolCallId).toEqual(expect.any(String));
    expect(calls[0]?.toolCallId).not.toBe("11");
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
    expect(collected.parts.some((part) => part.type === "text-delta")).toBe(false);
    expect(aborted).toBe(true);
    expect(conversationHistory).not.toHaveBeenCalled();
  });

  it("does not set onExec and does not apply a Cursor non-MCP exec as a V3 tool-call", async () => {
    const outbound: AgentClientMessage[] = [];
    const real = testClient({
      openRun: async function* (messages) {
        const iterator = messages[Symbol.asyncIterator]();
        await iterator.next();
        yield unknownExec();
        const reply = await withTimeout(iterator.next());
        if (reply.value !== undefined) {
          outbound.push(reply.value);
        }
        yield textDelta("ok");
        yield turnEnded();
      },
    });
    const wrapped = wrapClient(real);
    const model = new CursorLanguageModel({
      provider: "cursor-rpc",
      modelId: "composer",
      getClient: () => wrapped.client,
    });

    const collected = await withTimeout(
      model
        .doStream({ prompt: [user("run something")], tools: [writeTool()] })
        .then(async (result) => collectParts(result.stream)),
    );

    expect(String(collected.error)).not.toBe("hung");
    expect(wrapped.captured()?.handlers).toBeUndefined();
    expect(wrapped.captured()?.handlers?.onExec).toBeUndefined();
    expect(wrapped.captured()?.mode === "ask" || wrapped.captured()?.mode === undefined).toBe(true);
    expect(toolCalls(collected.parts)).toHaveLength(0);
    const throwReply = outbound.find((message) => message.message.case === "execClientControlMessage");
    expect(throwReply?.message.case).toBe("execClientControlMessage");
    if (throwReply?.message.case === "execClientControlMessage") {
      expect(throwReply.message.value.message.case).toBe("throw");
    }
    expect(JSON.stringify(outbound)).not.toMatch(/mcp_result|mcpResult|shellResult|shell_result/);
    real.close();
  });

  it("maps follow-up tool results into a new Run history and does not reuse the aborted transcript", async () => {
    const runs: ClientRunOptions[] = [];
    const poisonedHistory = vi.fn(
      () =>
        ({
          messages: [
            {
              message: {
                case: "assistant" as const,
                value: { content: [{ content: { case: "text" as const, value: { text: "tool not implemented" } } }] },
              },
            },
          ],
        }) as ConversationHistory,
    );
    const model = modelWithRun(async (options) => {
      runs.push(options);
      if (runs.length === 1) {
        return completedHandle([{ type: "mcp_args", toolName: "write", argsJson: WRITE_ARGS_JSON, id: 11 }], {
          conversationHistory: poisonedHistory,
        });
      }
      return completedHandle([
        { type: "text_delta", text: "done" },
        { type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
    });

    const first = await model.doStream({ prompt: [user("write a file")], tools: [writeTool()] });
    const firstCollected = await collectParts(first.stream);
    expect(toolCalls(firstCollected.parts)).toHaveLength(1);

    const followUp = await model.doStream({
      prompt: [
        user("write a file"),
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "oc-write-1", toolName: "write", input: WRITE_ARGS }],
        },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "oc-write-1", toolName: "write", output: { type: "text", value: "wrote" } },
          ],
        },
      ],
      tools: [writeTool()],
    });
    const collected = await collectParts(followUp.stream);

    expect(runs).toHaveLength(2);
    expect(runs[1]).not.toBe(runs[0]);
    expect(runs[1]?.prompt).toBe("write a file");
    expect(runs[1]?.handlers).toBeUndefined();
    expect(JSON.stringify(runs[1])).not.toMatch(/mcp_result|mcpResult/);
    const calls = historyToolCalls(runs[1]?.conversationHistory);
    const tools = historyToolMessages(runs[1]?.conversationHistory);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolCallId).toBe("oc-write-1");
    expect(calls[0]?.toolName).toBe("write");
    expect(calls[0]?.argsJson).toBe(WRITE_ARGS_JSON);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.toolCallId).toBe("oc-write-1");
    expect(tools[0]?.toolName).toBe("write");
    expect(tools[0]?.content.some((part) => part.content.case === "text" && part.content.value.text === "wrote")).toBe(
      true,
    );
    expect(historyTexts(runs[1]?.conversationHistory).join("\n")).not.toMatch(/tool not implemented/i);
    expect(poisonedHistory).not.toHaveBeenCalled();
    expect(collected.error).toBeUndefined();
  });

  it("does not turn display-only Cursor tool_call events into V3 tool-call parts", async () => {
    const model = modelWithRun(async () =>
      completedHandle([
        { type: "text_delta", text: "hi" },
        { type: "tool_call", callId: "display-1", toolCallId: "tc1", phase: "started" },
        { type: "tool_call", callId: "display-1", toolCallId: "tc1", phase: "completed" },
        { type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    );

    const { stream } = await model.doStream({ prompt: [user("hi")], tools: [writeTool()] });
    const collected = await collectParts(stream);

    expect(toolCalls(collected.parts)).toHaveLength(0);
    expect(collected.parts.some((part) => part.type === "tool-input-start")).toBe(false);
    expect(finishes(collected.parts)).toHaveLength(1);
  });

  it("does not emit a V3 tool-call for unadvertised mcp_args; aborts and finishes other", async () => {
    let aborted = false;
    const model = modelWithRun(async () =>
      completedHandle([{ type: "mcp_args", toolName: "bash", argsJson: '{"command":"ls"}', id: 12 }], {
        abort: () => {
          aborted = true;
        },
      }),
    );

    const collected = await withTimeout(
      model
        .doStream({ prompt: [user("write a file")], tools: [writeTool()] })
        .then(async (result) => collectParts(result.stream)),
    );

    expect(String(collected.error)).not.toBe("hung");
    expect(collected.error).toBeUndefined();
    expect(toolCalls(collected.parts)).toHaveLength(0);
    expect(collected.parts.some((part) => part.type === "tool-input-start")).toBe(false);
    const finish = finishes(collected.parts);
    expect(finish).toHaveLength(1);
    expect(finish[0]?.finishReason.unified).toBe("other");
    expect(
      streamWarnings(collected.parts).some(
        (warning) => warning.type === "other" && /unadvertised|not advertised|bash/i.test(warning.message),
      ),
    ).toBe(true);
    expect(aborted).toBe(true);
  });

  it("keeps shipped doStream as ASK and answers request_context_args with an empty workspace", async () => {
    const outbound: AgentClientMessage[] = [];
    const real = testClient({
      openRun: async function* (messages) {
        const iterator = messages[Symbol.asyncIterator]();
        const opening = await iterator.next();
        if (opening.value !== undefined) {
          outbound.push(opening.value);
        }
        yield requestContextArgs();
        const reply = await withTimeout(iterator.next());
        if (reply.value !== undefined) {
          outbound.push(reply.value);
        }
        yield textDelta("ok");
        yield turnEnded();
      },
    });
    const wrapped = wrapClient(real);
    const model = new CursorLanguageModel({
      provider: "cursor-rpc",
      modelId: "composer",
      getClient: () => wrapped.client,
    });

    const collected = await withTimeout(
      model
        .doStream({ prompt: [user("need context")], tools: [writeTool()] })
        .then(async (result) => collectParts(result.stream)),
    );

    expect(String(collected.error)).not.toBe("hung");
    expect(wrapped.captured()?.mode === "ask" || wrapped.captured()?.mode === undefined).toBe(true);
    expect(wrapped.captured()?.handlers).toBeUndefined();
    const opening = openingRequest(outbound[0]);
    expect(opening?.excludeWorkspaceContext).toBe(true);
    const action = userMessageAction(outbound[0]);
    expect(action?.userMessage?.mode === AgentMode.ASK || action?.userMessage?.mode === AgentMode.UNSPECIFIED).toBe(
      true,
    );
    expect(action?.requestContext?.env?.workspacePaths).toEqual([]);
    const contextReply = outbound.find((message) => message.message.case === "execClientMessage");
    expect(contextReply?.message.case).toBe("execClientMessage");
    if (contextReply?.message.case === "execClientMessage") {
      expect(contextReply.message.value.message.case).toBe("requestContextResult");
      if (contextReply.message.value.message.case === "requestContextResult") {
        expect(contextReply.message.value.message.value.requestContext?.env?.workspacePaths).toEqual([]);
      }
    }
    expect(toolCalls(collected.parts)).toHaveLength(0);
    real.close();
  });

  it("rejects mcp_auth_request_query on a tool-mapped ASK turn without a V3 tool-call or login()", async () => {
    const loginSpy = vi.spyOn(await import("cursor-rpc"), "login");
    const outbound: AgentClientMessage[] = [];
    const real = testClient({
      openRun: async function* (messages) {
        const iterator = messages[Symbol.asyncIterator]();
        await iterator.next();
        yield mcpAuthQuery();
        const reply = await withTimeout(iterator.next());
        if (reply.value !== undefined) {
          outbound.push(reply.value);
        }
        yield textDelta("ok");
        yield turnEnded();
      },
    });
    const wrapped = wrapClient(real);
    const model = new CursorLanguageModel({
      provider: "cursor-rpc",
      modelId: "composer",
      getClient: () => wrapped.client,
    });

    const collected = await withTimeout(
      model
        .doStream({ prompt: [user("auth?")], tools: [writeTool()] })
        .then(async (result) => collectParts(result.stream)),
    );

    expect(String(collected.error)).not.toBe("hung");
    expect(collected.error).toBeUndefined();
    expect(toolCalls(collected.parts)).toHaveLength(0);
    expect(loginSpy).not.toHaveBeenCalled();
    expect(wrapped.captured()?.mode === "ask" || wrapped.captured()?.mode === undefined).toBe(true);
    const response = outbound.find((message) => message.message.case === "interactionResponse");
    expect(response?.message.case).toBe("interactionResponse");
    if (response?.message.case === "interactionResponse") {
      expect(response.message.value.result.case).toBe("mcpAuthRequestResponse");
      const result = response.message.value.result;
      if (result.case === "mcpAuthRequestResponse") {
        expect(result.value.result.case).toBe("rejected");
      }
    }
    real.close();
    loginSpy.mockRestore();
  });
});
