import { create } from "@bufbuild/protobuf";
import { APICallError, type LanguageModelV3CallOptions, type LanguageModelV3StreamPart } from "@ai-sdk/provider";
import {
  CancelledError,
  createClient,
  StreamError,
  TransportUnsupportedError,
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
  AgentServerMessageSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  McpAuthRequestQuerySchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  type AgentServerMessage,
} from "../../cursor-rpc/src/generated/agent/v1/agent_pb.ts";
import type { BootstrapClients } from "../../cursor-rpc/src/session/bootstrap.ts";
import { CursorLanguageModel } from "../src/language-model.ts";

const MODEL = create(ModelDetailsSchema, { modelId: "composer-2.5", displayName: "Composer" });

function user(text: string): LanguageModelV3CallOptions["prompt"][number] {
  return { role: "user", content: [{ type: "text", text }] };
}

function emptyHistory(): ConversationHistory {
  return { messages: [] } as ConversationHistory;
}

function completedHandle(events: RunEvent[], abort: () => void = () => undefined): RunHandle {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    wait: async () => ({
      text: events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""),
      usage: events.find((event) => event.type === "turn_ended")?.usage ?? {},
      events,
    }),
    abort,
    conversationHistory: emptyHistory,
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

function modelWithEvents(events: RunEvent[]): CursorLanguageModel {
  return modelWithRun(async () => completedHandle(events));
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

function textDeltas(parts: LanguageModelV3StreamPart[]): string[] {
  return parts.filter((part) => part.type === "text-delta").map((part) => part.delta);
}

function reasoningDeltas(parts: LanguageModelV3StreamPart[]): string[] {
  return parts.filter((part) => part.type === "reasoning-delta").map((part) => part.delta);
}

function finishes(parts: LanguageModelV3StreamPart[]): Array<Extract<LanguageModelV3StreamPart, { type: "finish" }>> {
  return parts.filter((part) => part.type === "finish");
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
          value: create(TurnEndedUpdateSchema, { inputTokens: 1, outputTokens: 2 }),
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

function extractPrompt(message: AgentClientMessage | undefined): string {
  if (message?.message.case !== "runRequest") {
    return "";
  }
  const action = message.message.value.action?.action;
  if (action?.case !== "userMessageAction") {
    return "";
  }
  return action.value.userMessage?.text ?? "";
}

function testClient(options: {
  openRun?: NonNullable<Parameters<typeof createClient>[0]["openRun"]>;
  bootstrap?: Partial<BootstrapClients>;
}): CursorRpcClient {
  return createClient({
    apiKey: "key_stream_test",
    env: {},
    fetch: async () =>
      new Response(JSON.stringify({ accessToken: "tok", refreshToken: "ref" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    bootstrapClients: bootstrapClients(options.bootstrap),
    openRun: options.openRun,
  });
}

describe("stream mapping", () => {
  it("emits stream-start, the text triad, and finish with usage from turn_ended", async () => {
    const model = modelWithEvents([
      { type: "text_delta", text: "Hello" },
      {
        type: "turn_ended",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: 3,
        },
      },
    ]);

    const result = await model.doStream({
      prompt: [user("Hi")],
      temperature: 0.4,
      topP: 0.8,
      tools: [{ type: "function", name: "lookup", inputSchema: { type: "object" } }],
    });
    const { parts, error } = await collectParts(result.stream);

    expect(error).toBeUndefined();
    expect(parts[0]).toEqual({
      type: "stream-start",
      warnings: expect.arrayContaining([
        expect.objectContaining({ type: "unsupported", feature: "temperature" }),
        expect.objectContaining({ type: "unsupported", feature: "topP" }),
        expect.objectContaining({ type: "unsupported", feature: "tools" }),
      ]),
    });
    const textId = parts.find((part) => part.type === "text-start")?.id;
    expect(textId).toEqual(expect.any(String));
    expect(parts).toEqual(
      expect.arrayContaining([
        { type: "text-start", id: textId },
        { type: "text-delta", id: textId, delta: "Hello" },
        { type: "text-end", id: textId },
      ]),
    );
    const finish = finishes(parts);
    expect(finish).toHaveLength(1);
    expect(finish[0]?.finishReason).toEqual({ unified: "stop", raw: expect.any(String) });
    expect(finish[0]?.usage).toEqual({
      inputTokens: { total: 10, noCache: undefined, cacheRead: 2, cacheWrite: 1 },
      outputTokens: { total: 4, text: undefined, reasoning: 3 },
    });
    expect(parts.some((part) => part.type === "tool-call")).toBe(false);
  });

  it("maps thinking_delta to reasoning and never as text-delta", async () => {
    const model = modelWithEvents([
      { type: "thinking_delta", text: "ponder" },
      { type: "thinking_completed", durationMs: 12 },
      { type: "text_delta", text: "answer" },
      { type: "turn_ended", usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 1 } },
    ]);

    const { stream } = await model.doStream({ prompt: [user("why")] });
    const { parts, error } = await collectParts(stream);

    expect(error).toBeUndefined();
    expect(textDeltas(parts)).toEqual(["answer"]);
    expect(textDeltas(parts)).not.toContain("ponder");
    expect(reasoningDeltas(parts)).toEqual(["ponder"]);
    const reasoningId = parts.find((part) => part.type === "reasoning-start")?.id;
    expect(reasoningId).toEqual(expect.any(String));
    expect(parts).toEqual(
      expect.arrayContaining([
        { type: "reasoning-start", id: reasoningId },
        { type: "reasoning-delta", id: reasoningId, delta: "ponder" },
        { type: "reasoning-end", id: reasoningId },
      ]),
    );
    expect(finishes(parts)).toHaveLength(1);
  });

  it("ignores display tool_call events in the V3 stream", async () => {
    const model = modelWithEvents([
      { type: "text_delta", text: "hi" },
      { type: "tool_call", callId: "display-1", toolCallId: "tc1", phase: "started" },
      { type: "tool_call", callId: "display-1", toolCallId: "tc1", phase: "completed" },
      { type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);

    const { stream } = await model.doStream({ prompt: [user("hi")] });
    const { parts } = await collectParts(stream);

    expect(parts.some((part) => part.type === "tool-call" || part.type === "tool-input-start")).toBe(false);
    expect(textDeltas(parts)).toEqual(["hi"]);
    expect(finishes(parts)).toHaveLength(1);
  });

  it("aborts a mid-text Run and does not successful-finish", async () => {
    const waiters: Array<(event: RunEvent) => void> = [];
    let cancelled = false;
    const model = modelWithRun(async (options) => {
      options.signal?.addEventListener(
        "abort",
        () => {
          cancelled = true;
          for (const waiter of waiters.splice(0)) {
            waiter({ type: "heartbeat" });
          }
        },
        { once: true },
      );
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text_delta", text: "hel" };
          await new Promise<void>((resolve, reject) => {
            if (options.signal?.aborted) {
              reject(new CancelledError());
              return;
            }
            waiters.push(() => {
              reject(new CancelledError());
            });
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new CancelledError();
        },
        wait: async () => {
          throw new CancelledError();
        },
        abort: () => {
          cancelled = true;
        },
        conversationHistory: emptyHistory,
      };
    });

    const abort = new AbortController();
    const { stream } = await model.doStream({ prompt: [user("hi")], abortSignal: abort.signal });
    const reader = stream.getReader();
    const parts: LanguageModelV3StreamPart[] = [];
    let streamError: unknown;
    const pumping = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          parts.push(value);
          if (value.type === "text-delta") {
            abort.abort();
          }
        }
      } catch (error) {
        streamError = error;
      }
    })();
    await pumping;

    expect(cancelled).toBe(true);
    expect(finishes(parts).some((part) => part.finishReason.unified === "stop")).toBe(false);
    expect(streamError !== undefined || parts.some((part) => part.type === "error")).toBe(true);
    const errorPart = parts.find((part) => part.type === "error");
    if (errorPart?.type === "error") {
      expect(APICallError.isInstance(errorPart.error) || errorPart.error instanceof CancelledError).toBe(true);
      expect(inspectSafe(errorPart.error)).not.toMatch(/apiKey|Bearer |CURSOR_API_KEY/);
    }
    if (streamError !== undefined) {
      expect(APICallError.isInstance(streamError) || streamError instanceof CancelledError).toBe(true);
      expect(inspectSafe(streamError)).not.toMatch(/apiKey|Bearer |CURSOR_API_KEY/);
    }
  });

  it("keeps a second concurrent Run alive after aborting the first and does not close() the client", async () => {
    const client = testClient({
      openRun: async function* (outbound, options) {
        const first = await outbound[Symbol.asyncIterator]().next();
        const prompt = extractPrompt(first.value);
        if (prompt === "A") {
          yield textDelta("aaa");
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) {
              resolve();
              return;
            }
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return;
        }
        yield textDelta("bbb");
        yield turnEnded();
      },
    });
    const close = vi.spyOn(client, "close");
    const model = new CursorLanguageModel({
      provider: "cursor-rpc",
      modelId: "composer",
      getClient: () => client,
    });

    const abortA = new AbortController();
    const streamA = await model.doStream({ prompt: [user("A")], abortSignal: abortA.signal });
    const streamB = await model.doStream({ prompt: [user("B")] });

    const readerA = streamA.stream.getReader();
    while (true) {
      const { done, value } = await readerA.read();
      if (done) {
        break;
      }
      if (value.type === "text-delta") {
        abortA.abort();
        break;
      }
    }
    const restA = await collectPartsFromReader(readerA);
    const collectedB = await collectParts(streamB.stream);

    expect(textDeltas(collectedB.parts)).toEqual(["bbb"]);
    expect(finishes(collectedB.parts)).toHaveLength(1);
    expect(collectedB.error).toBeUndefined();
    expect(finishes(restA.parts).some((part) => part.finishReason.unified === "stop")).toBe(false);
    expect(close).not.toHaveBeenCalled();
    client.close();
  });

  it("maps HTTP/1.1 TransportUnsupportedError to a provider error instead of hanging", async () => {
    const client = testClient({
      bootstrap: {
        getServerConfig: async () =>
          create(GetServerConfigResponseSchema, {
            http2Config: Http2Config.FORCE_ALL_DISABLED,
          }),
      },
    });
    const model = new CursorLanguageModel({
      provider: "cursor-rpc",
      modelId: "composer",
      getClient: () => client,
    });

    const outcome = await Promise.race([
      model
        .doStream({ prompt: [user("hi")] })
        .then(async (result) => ({ kind: "stream" as const, result }))
        .catch((error: unknown) => ({ kind: "throw" as const, error })),
      new Promise<{ kind: "hang" }>((resolve) => {
        setTimeout(() => resolve({ kind: "hang" }), 1500);
      }),
    ]);

    expect(outcome.kind).not.toBe("hang");
    if (outcome.kind === "throw") {
      expect(APICallError.isInstance(outcome.error) || outcome.error instanceof TransportUnsupportedError).toBe(true);
      expect(String(outcome.error)).toMatch(/HTTP\/2|unavailable|failed_precondition/i);
      expect(inspectSafe(outcome.error)).not.toMatch(/apiKey|Bearer |CURSOR_API_KEY|headers|Authorization/);
    } else if (outcome.kind === "stream") {
      const collected = await Promise.race([
        collectParts(outcome.result.stream),
        new Promise<{ parts: LanguageModelV3StreamPart[]; error: unknown }>((resolve) => {
          setTimeout(() => resolve({ parts: [], error: new Error("hung") }), 1500);
        }),
      ]);
      expect(String(collected.error)).not.toBe("hung");
      expect(
        collected.parts.some((part) => part.type === "error") || collected.error !== undefined,
      ).toBe(true);
      expect(finishes(collected.parts).some((part) => part.finishReason.unified === "stop")).toBe(false);
    }
    client.close();
  });

  it("rejects mcp_auth_request_query, finishes the stream, and does not open a browser", async () => {
    const loginSpy = vi.spyOn(await import("cursor-rpc"), "login");
    let outbound: AgentClientMessage[] = [];
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

    const { stream } = await model.doStream({ prompt: [user("auth?")] });
    const collected = await Promise.race([
      collectParts(stream),
      new Promise<{ parts: LanguageModelV3StreamPart[]; error: unknown }>((resolve) => {
        setTimeout(() => resolve({ parts: [], error: new Error("hung") }), 2000);
      }),
    ]);

    expect(String(collected.error)).not.toBe("hung");
    expect(collected.error).toBeUndefined();
    expect(textDeltas(collected.parts)).toEqual(["ok"]);
    expect(finishes(collected.parts)).toHaveLength(1);
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
    client.close();
    loginSpy.mockRestore();
  });

  it("emits finish with unified other and a warning when turn_ended is missing", async () => {
    const model = modelWithEvents([{ type: "text_delta", text: "partial" }]);
    const { stream } = await model.doStream({ prompt: [user("hi")] });
    const collected = await Promise.race([
      collectParts(stream),
      new Promise<{ parts: LanguageModelV3StreamPart[]; error: unknown }>((resolve) => {
        setTimeout(() => resolve({ parts: [], error: new Error("hung") }), 1500);
      }),
    ]);

    expect(String(collected.error)).not.toBe("hung");
    expect(collected.error).toBeUndefined();
    expect(textDeltas(collected.parts)).toEqual(["partial"]);
    const finish = finishes(collected.parts);
    expect(finish).toHaveLength(1);
    expect(finish[0]?.finishReason.unified).toBe("other");
    const warningSources = collected.parts
      .filter((part): part is Extract<LanguageModelV3StreamPart, { type: "stream-start" }> => part.type === "stream-start")
      .flatMap((part) => part.warnings);
    expect(
      warningSources.some(
        (warning) =>
          warning.type === "other" && /turn_ended|turn ended|missing/i.test(warning.message),
      ),
    ).toBe(true);
  });

  it("maps a stall StreamError to a stream error without a successful finish", async () => {
    const model = modelWithRun(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "text_delta", text: "hel" };
        throw new StreamError("stall_detector", { code: "deadline_exceeded", isRetryable: true });
      },
      wait: async () => {
        throw new StreamError("stall_detector", { code: "deadline_exceeded", isRetryable: true });
      },
      abort: () => undefined,
      conversationHistory: emptyHistory,
    }));

    const { stream } = await model.doStream({ prompt: [user("hi")] });
    const collected = await collectParts(stream);
    expect(finishes(collected.parts).some((part) => part.finishReason.unified === "stop")).toBe(false);
    expect(collected.error !== undefined || collected.parts.some((part) => part.type === "error")).toBe(true);
  });

  it("doGenerate consumes doStream and returns content, finishReason, and usage", async () => {
    const model = modelWithEvents([
      { type: "thinking_delta", text: "think" },
      { type: "thinking_completed", durationMs: 1 },
      { type: "text_delta", text: "done" },
      { type: "turn_ended", usage: { inputTokens: 5, outputTokens: 2 } },
    ]);

    const generated = await model.doGenerate({ prompt: [user("go")] });
    expect(generated.content).toEqual(
      expect.arrayContaining([
        { type: "reasoning", text: "think" },
        { type: "text", text: "done" },
      ]),
    );
    expect(generated.finishReason.unified).toBe("stop");
    expect(generated.usage.inputTokens.total).toBe(5);
    expect(generated.usage.outputTokens.total).toBe(2);
    expect(generated.warnings).toEqual(expect.any(Array));
  });
});

async function collectPartsFromReader(
  reader: ReadableStreamDefaultReader<LanguageModelV3StreamPart>,
): Promise<{ parts: LanguageModelV3StreamPart[]; error: unknown }> {
  const parts: LanguageModelV3StreamPart[] = [];
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

function inspectSafe(value: unknown): string {
  return String(value);
}
