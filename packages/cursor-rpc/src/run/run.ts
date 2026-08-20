import { create, fromBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { randomUUID } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { AuthenticationError, CancelledError, StreamError } from "../errors.js";
import { mapTransportError } from "../transport/connect.js";
import {
  AgentClientMessageSchema,
  AgentMode,
  AgentRunRequestSchema,
  ClientHeartbeatSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationTokenDetailsSchema,
  McpToolDefinitionSchema,
  McpToolsSchema,
  RequestContextEnvSchema,
  RequestContextSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  type AgentClientMessage,
  type AgentServerMessage,
  type ConversationHistory,
} from "../generated/agent/v1/agent_pb.js";
import { dispatchServerMessage, type DispatchHandlers, type InFlightExec } from "./dispatch.js";
import { startHeartbeat, startStallTimer } from "./heartbeat.js";
import { AsyncQueue } from "./queue.js";
import { buildConversationHistory, textFromEvents } from "./transcript.js";
import type { RunEvent, RunResult } from "./events.js";

export const DEFAULT_EXCLUDE_TOOLS = ["web_search_tool_call", "web_fetch_tool_call"] as const;
export const DEFAULT_MCP_ALLOWED_TOOLS = ["mcp_tool_call", "get_mcp_tools_tool_call"] as const;

export type McpToolDto = {
  name: string;
  description?: string;
  inputSchemaJson?: string;
};

export type RunMode = "ask" | "agent";

export type RunRequestOptions = {
  conversationId?: string;
  runId?: string;
  mode?: RunMode;
  mcpTools?: McpToolDto[];
  customSystemPrompt?: string;
  maxTokens?: number;
};

export type RunOptions = {
  prompt: string;
  conversationHistory?: ConversationHistory;
  inbound: AsyncIterable<AgentServerMessage>;
  send: (message: AgentClientMessage) => void | Promise<void>;
  signal?: AbortSignal;
  handlers?: DispatchHandlers;
  heartbeatMs?: number;
  stallMs?: number;
  onUnauthenticated?: (error: unknown) => void;
} & RunRequestOptions;

export type RunHandle = AsyncIterable<RunEvent> & {
  wait: () => Promise<RunResult>;
  abort: () => void;
  conversationHistory: () => ConversationHistory;
};

export function runHeaders(
  options: {
    allowWebSearch?: boolean;
    allowWebFetch?: boolean;
    allowedTools?: string[];
    excludeTools?: string[];
    mcpTools?: boolean;
  } = {},
): Headers {
  const headers = new Headers();
  if (options.mcpTools === true) {
    const allowed = options.allowedTools ?? [...DEFAULT_MCP_ALLOWED_TOOLS];
    if (allowed.length > 0) {
      headers.set("x-cursor-agent-allowed-tools", allowed.join(","));
    }
    return headers;
  }
  const exclude: string[] = [];
  if (options.allowWebSearch !== true) {
    exclude.push(DEFAULT_EXCLUDE_TOOLS[0]);
  }
  if (options.allowWebFetch !== true) {
    exclude.push(DEFAULT_EXCLUDE_TOOLS[1]);
  }
  if (options.excludeTools !== undefined) {
    exclude.push(...options.excludeTools);
  }
  if (exclude.length > 0) {
    headers.set("x-cursor-agent-exclude-tools", exclude.join(","));
  }
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    headers.set("x-cursor-agent-allowed-tools", options.allowedTools.join(","));
  }
  return headers;
}

export function openingRunRequest(
  prompt: string,
  history?: ConversationHistory,
  extras: RunRequestOptions = {},
): AgentClientMessage {
  const mcpTools = extras.mcpTools ?? [];
  const agentTurn = mcpTools.length > 0 || extras.mode === "agent";
  const mode = extras.mode === "ask" ? AgentMode.ASK : agentTurn ? AgentMode.AGENT : AgentMode.ASK;
  return create(AgentClientMessageSchema, {
    message: {
      case: "runRequest",
      value: create(AgentRunRequestSchema, {
        conversationId: extras.conversationId ?? randomUUID(),
        runId: extras.runId,
        customSystemPrompt: extras.customSystemPrompt,
        excludeWorkspaceContext: true,
        mcpTools:
          mcpTools.length > 0
            ? create(McpToolsSchema, {
                mcpTools: mcpTools.map((tool) =>
                  create(McpToolDefinitionSchema, {
                    name: tool.name,
                    description: tool.description ?? "",
                    toolName: tool.name,
                    providerIdentifier: "cursor-rpc",
                    inputSchemaJson: tool.inputSchemaJson,
                  }),
                ),
              })
            : undefined,
        conversationState: create(ConversationStateStructureSchema, {
          tokenDetails:
            extras.maxTokens !== undefined
              ? create(ConversationTokenDetailsSchema, { maxTokens: extras.maxTokens })
              : undefined,
        }),
        action: create(ConversationActionSchema, {
          action: {
            case: "userMessageAction",
            value: create(UserMessageActionSchema, {
              userMessage: create(UserMessageSchema, {
                text: prompt,
                messageId: randomUUID(),
                mode,
              }),
              requestContext: create(RequestContextSchema, {
                env: create(RequestContextEnvSchema, { workspacePaths: [] }),
              }),
              conversationHistory: history,
            }),
          },
        }),
      }),
    },
  });
}

export function runTurn(options: RunOptions): RunHandle {
  const events = new AsyncQueue<RunEvent>();
  const collected: RunEvent[] = [];
  const inFlight = new Map<number, InFlightExec>();
  const pendingExecs: Array<Promise<void>> = [];
  const abort = new AbortController();
  let heartbeat: { stop: () => void } | undefined;
  let stall: { touch: () => void; stop: () => void } | undefined;

  const stopTimers = () => {
    heartbeat?.stop();
    stall?.stop();
    heartbeat = undefined;
    stall = undefined;
  };

  const fail = (error: unknown) => {
    stopTimers();
    events.close(error);
  };

  const finish = (result: RunResult) => {
    stopTimers();
    events.close();
    return result;
  };

  const throwIfAborted = (): never => {
    throw abort.signal.reason instanceof StreamError
      ? abort.signal.reason
      : CancelledError.fromAbort(abort.signal.reason);
  };

  const onCallerAbort = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const loop = (async () => {
    try {
      await options.send(
        openingRunRequest(options.prompt, options.conversationHistory, {
          conversationId: options.conversationId,
          runId: options.runId,
          mode: options.mode,
          mcpTools: options.mcpTools,
          customSystemPrompt: options.customSystemPrompt,
          maxTokens: options.maxTokens,
        }),
      );
      events.push({ type: "connection", state: "connected" });
      heartbeat = startHeartbeat(
        () => {
          void options.send(
            create(AgentClientMessageSchema, {
              message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
            }),
          );
        },
        { intervalMs: options.heartbeatMs },
      );
      stall = startStallTimer(
        () => {
          const error = new StreamError("stall_detector", { code: "deadline_exceeded", isRetryable: true });
          abort.abort(error);
          fail(error);
        },
        { stallMs: options.stallMs },
      );

      const iterator = options.inbound[Symbol.asyncIterator]();
      const abortWait = new Promise<IteratorResult<AgentServerMessage>>((resolve) => {
        const onAbort = () => {
          resolve({ done: true, value: undefined });
        };
        if (abort.signal.aborted) {
          onAbort();
          return;
        }
        abort.signal.addEventListener("abort", onAbort, { once: true });
      });
      while (!abort.signal.aborted) {
        const next = await Promise.race([iterator.next(), abortWait]);
        if (next.done === true) {
          if (abort.signal.aborted) {
            throwIfAborted();
          }
          break;
        }
        if (abort.signal.aborted) {
          throwIfAborted();
        }
        stall?.touch();
        const event = toPublicEvent(next.value);
        if (event !== undefined) {
          collected.push(event);
          events.push(event);
          if (event.type === "turn_ended") {
            await Promise.all(pendingExecs);
            return finish({
              text: textFromEvents(collected),
              usage: event.usage,
              events: collected,
            });
          }
        }
        if (next.value.message.case === "execServerMessage") {
          const exec = next.value.message.value;
          if (!inFlight.has(exec.id)) {
            inFlight.set(exec.id, { abort: new AbortController() });
          }
          pendingExecs.push(
            dispatchServerMessage(next.value, {
              handlers: options.handlers,
              inFlight,
              signal: abort.signal,
            }).then(async (reply) => {
              if (reply !== undefined) {
                await options.send(reply);
              }
            }),
          );
          continue;
        }
        const reply = await dispatchServerMessage(next.value, {
          handlers: options.handlers,
          inFlight,
          signal: abort.signal,
        });
        if (reply !== undefined) {
          await options.send(reply);
        }
      }
      if (abort.signal.aborted) {
        throwIfAborted();
      }
      throw new StreamError("stream ended without turn_ended", { code: "unknown" });
    } catch (error) {
      if (error instanceof StreamError) {
        fail(error);
        throw error;
      }
      const connect = ConnectError.from(error);
      if (connect.code === Code.Unauthenticated) {
        const mapped = AuthenticationError.from(connect, { code: "unauthenticated" });
        options.onUnauthenticated?.(connect);
        fail(mapped);
        throw mapped;
      }
      if (abort.signal.reason instanceof StreamError) {
        fail(abort.signal.reason);
        throw abort.signal.reason;
      }
      if (abort.signal.aborted || options.signal?.aborted) {
        const cancelled = CancelledError.fromAbort(abort.signal.reason ?? options.signal?.reason);
        fail(cancelled);
        throw cancelled;
      }
      const mapped = error instanceof StreamError ? error : mapTransportError(error);
      fail(mapped);
      throw mapped;
    } finally {
      await Promise.allSettled(pendingExecs);
      options.signal?.removeEventListener("abort", onCallerAbort);
      stopTimers();
    }
  })();
  void loop.catch(() => undefined);

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const event of events) {
          yield event;
        }
      } finally {
        abort.abort();
        stopTimers();
      }
    },
    wait: () => loop,
    abort: () => abort.abort(),
    conversationHistory: () => buildConversationHistory(options.prompt, collected),
  };
}

function toCount(value: bigint | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Number(value);
}

function mcpArgumentsJson(args: { [key: string]: Uint8Array }): string {
  const decoded: Record<string, unknown> = {};
  for (const [key, bytes] of Object.entries(args)) {
    decoded[key] = decodeMcpArg(bytes);
  }
  return JSON.stringify(decoded);
}

function decodeMcpArg(bytes: Uint8Array): unknown {
  try {
    return toJson(ValueSchema, fromBinary(ValueSchema, bytes));
  } catch {
    const text = new TextDecoder().decode(bytes);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}

function toPublicEvent(inbound: AgentServerMessage): RunEvent | undefined {
  if (inbound.message.case === "conversationCheckpointUpdate") {
    return { type: "checkpoint" };
  }
  if (inbound.message.case === "execServerMessage") {
    const exec = inbound.message.value;
    if (exec.message.case !== "mcpArgs") {
      return undefined;
    }
    const args = exec.message.value;
    return {
      type: "mcp_exec",
      id: exec.id,
      execId: exec.execId,
      name: args.toolName.length > 0 ? args.toolName : args.name,
      argumentsJson: mcpArgumentsJson(args.args),
      toolCallId: args.toolCallId,
    };
  }
  if (inbound.message.case !== "interactionUpdate") {
    return undefined;
  }
  const update = inbound.message.value.message;
  switch (update.case) {
    case "textDelta":
      return update.value.isServerNotice
        ? { type: "server_notice", text: update.value.text }
        : { type: "text_delta", text: update.value.text };
    case "thinkingDelta":
      return { type: "thinking_delta", text: update.value.text };
    case "thinkingCompleted":
      return { type: "thinking_completed", durationMs: update.value.thinkingDurationMs };
    case "tokenDelta":
      return { type: "token_delta", tokens: update.value.tokens };
    case "heartbeat":
      return { type: "heartbeat" };
    case "turnEnded":
      return {
        type: "turn_ended",
        usage: {
          inputTokens: toCount(update.value.inputTokens),
          outputTokens: toCount(update.value.outputTokens),
          cacheReadTokens: toCount(update.value.cacheReadTokens),
          cacheWriteTokens: toCount(update.value.cacheWriteTokens),
          reasoningTokens: toCount(update.value.reasoningTokens),
        },
      };
    case "toolCallStarted":
    case "toolCallCompleted":
    case "partialToolCall":
      return {
        type: "tool_call",
        callId: update.value.callId,
        toolCallId: update.value.toolCall?.toolCallId,
        phase: update.case === "toolCallStarted" ? "started" : update.case === "toolCallCompleted" ? "completed" : "partial",
      };
    case "promptSuggestion":
      return { type: "prompt_suggestion", suggestion: update.value.suggestion };
    case "routedModel":
      return { type: "routed_model", displayName: update.value.displayName };
    default:
      return undefined;
  }
}
