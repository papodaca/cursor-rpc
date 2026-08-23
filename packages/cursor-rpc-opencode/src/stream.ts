import { randomUUID } from "node:crypto";
import {
  APICallError,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FinishReason,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
  type SharedV3Warning,
} from "@ai-sdk/provider";
import {
  CancelledError,
  CursorRpcError,
  StreamError,
  type ClientRunOptions,
  type CursorRpcClient,
  type McpToolDto,
  type RunEvent,
  type RunHandle,
  type UsageCounts,
} from "cursor-rpc";
import { mapPrompt } from "./prompt.js";

type ProbeRunMode = NonNullable<ClientRunOptions["mode"]>;

const MISSING_TURN_ENDED = "stream ended without turn_ended";
const OPENCODE_STALL_MS = 180_000;

const UNSUPPORTED_SAMPLING = [
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "maxOutputTokens",
  "stopSequences",
  "seed",
  "toolChoice",
] as const satisfies ReadonlyArray<keyof LanguageModelV3CallOptions>;

export function toProviderError(error: unknown): APICallError {
  const wrapped = error instanceof CursorRpcError ? error : CursorRpcError.from(error);
  const stalled = wrapped instanceof StreamError && wrapped.message === "stall_detector";
  return new APICallError({
    message: stalled
      ? "Cursor sent no stream activity before the stall timeout. The model may still be thinking; retrying starts a new Run."
      : wrapped.message,
    url: "cursor-rpc",
    requestBodyValues: {},
    isRetryable: stalled ? false : wrapped.isRetryable,
  });
}

export async function streamCursorRun(options: {
  client: CursorRpcClient;
  modelId: string;
  call: LanguageModelV3CallOptions;
  /** Test-only AGENT probe. Shipped `doStream` omits this so the Run stays ASK. */
  mode?: ProbeRunMode;
}): Promise<LanguageModelV3StreamResult> {
  const mapped = mapPrompt(options.call.prompt);
  const warnings = [...callWarnings(options.call), ...mapped.warnings];
  const mcpTools = mapMcpTools(options.call.tools);
  const runOptions = clientRunOptions(options.modelId, options.call, mapped, mcpTools, options.mode);

  let handle: RunHandle;
  try {
    handle = await options.client.run(runOptions);
  } catch (error) {
    throw toProviderError(normalizeRunError(error, options.call.abortSignal));
  }

  return {
    stream: pumpHandle(
      handle,
      options.call.abortSignal,
      warnings,
      new Set((mcpTools ?? []).map((tool) => tool.toolName ?? tool.name)),
    ),
  };
}

export async function consumeCursorStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3GenerateResult> {
  const reader = stream.getReader();
  const content: LanguageModelV3Content[] = [];
  const warnings: SharedV3Warning[] = [];
  const texts = new Map<string, string[]>();
  const reasonings = new Map<string, string[]>();
  let finishReason: LanguageModelV3FinishReason | undefined;
  let usage: LanguageModelV3Usage | undefined;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done === true) {
        break;
      }
      const part = next.value;
      switch (part.type) {
        case "stream-start":
          warnings.push(...part.warnings);
          break;
        case "text-delta": {
          const chunks = texts.get(part.id) ?? [];
          chunks.push(part.delta);
          texts.set(part.id, chunks);
          break;
        }
        case "text-end":
          content.push({ type: "text", text: (texts.get(part.id) ?? []).join("") });
          break;
        case "reasoning-delta": {
          const chunks = reasonings.get(part.id) ?? [];
          chunks.push(part.delta);
          reasonings.set(part.id, chunks);
          break;
        }
        case "reasoning-end":
          content.push({ type: "reasoning", text: (reasonings.get(part.id) ?? []).join("") });
          break;
        case "tool-call":
          content.push(part);
          break;
        case "finish":
          finishReason = part.finishReason;
          usage = part.usage;
          warnings.push(...warningsFromFinish(part));
          break;
        case "error":
          throw part.error;
        default:
          break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (finishReason === undefined || usage === undefined) {
    throw toProviderError(new StreamError(MISSING_TURN_ENDED));
  }

  return { content, finishReason, usage, warnings };
}

function clientRunOptions(
  modelId: string,
  call: LanguageModelV3CallOptions,
  mapped: ReturnType<typeof mapPrompt>,
  mcpTools: McpToolDto[] | undefined,
  mode?: ProbeRunMode,
): ClientRunOptions {
  const options: ClientRunOptions = {
    prompt: mapped.prompt,
    modelId,
    stallMs: OPENCODE_STALL_MS,
    excludeWorkspaceContext: false,
  };
  if (call.abortSignal !== undefined) {
    options.signal = call.abortSignal;
  }
  if (mapped.conversationHistory !== undefined) {
    options.conversationHistory = mapped.conversationHistory;
  }
  if (mcpTools !== undefined) {
    options.mcpTools = mcpTools;
  }
  if (mode === "agent") {
    options.mode = "agent";
  }
  return options;
}

function mapMcpTools(tools: LanguageModelV3CallOptions["tools"]): McpToolDto[] | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }
  const mapped: McpToolDto[] = [];
  for (const tool of tools) {
    if (tool.type !== "function") {
      continue;
    }
    mapped.push({
      name: tool.name,
      toolName: tool.name,
      providerIdentifier: "opencode",
      description: tool.description ?? "",
      inputSchemaJson: JSON.stringify(tool.inputSchema),
    });
  }
  return mapped.length === 0 ? undefined : mapped;
}

function callWarnings(call: LanguageModelV3CallOptions): SharedV3Warning[] {
  const warnings: SharedV3Warning[] = [];
  for (const feature of UNSUPPORTED_SAMPLING) {
    if (call[feature] !== undefined) {
      warnings.push({ type: "unsupported", feature, details: `${feature} is not forwarded to Cursor` });
    }
  }
  if (call.responseFormat !== undefined && call.responseFormat.type === "json") {
    warnings.push({
      type: "unsupported",
      feature: "responseFormat",
      details: "json responseFormat is not forwarded to Cursor",
    });
  }
  return warnings;
}

function pumpHandle(
  handle: RunHandle,
  abortSignal: AbortSignal | undefined,
  warnings: SharedV3Warning[],
  advertisedTools: ReadonlySet<string>,
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      const onAbort = (): void => {
        handle.abort();
      };
      if (isAborted(abortSignal)) {
        handle.abort();
        controller.error(toProviderError(new CancelledError()));
        return;
      }

      let textId: string | undefined;
      let reasoningId: string | undefined;
      let textSeq = 0;
      let reasoningSeq = 0;
      let finished = false;

      const closeText = (): void => {
        if (textId !== undefined) {
          controller.enqueue({ type: "text-end", id: textId });
          textId = undefined;
        }
      };
      const closeReasoning = (): void => {
        if (reasoningId !== undefined) {
          controller.enqueue({ type: "reasoning-end", id: reasoningId });
          reasoningId = undefined;
        }
      };
      const closeStream = (): void => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const ctx = {
        abortHandle: () => {
          handle.abort();
        },
        advertisedTools,
        closeReasoning,
        closeText,
        controller,
        nextReasoningId: () => {
          reasoningSeq += 1;
          reasoningId = `reasoning-${reasoningSeq}`;
          return reasoningId;
        },
        nextTextId: () => {
          textSeq += 1;
          textId = `text-${textSeq}`;
          return textId;
        },
        onFinish: () => {
          finished = true;
        },
        reasoningId: () => reasoningId,
        startWarningCount: warnings.length,
        textId: () => textId,
        warnings,
      };

      try {
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        controller.enqueue({ type: "stream-start", warnings: warnings.slice() });
        for await (const event of handle) {
          if (isAborted(abortSignal)) {
            throw new CancelledError();
          }
          applyEvent(event, ctx);
          if (finished) {
            break;
          }
        }
        if (!finished) {
          if (isAborted(abortSignal)) {
            throw new CancelledError();
          }
          emitMissingTurnEnded(controller, closeReasoning, closeText, warnings, ctx.startWarningCount);
        }
        closeStream();
      } catch (error) {
        if (finished && !isAborted(abortSignal)) {
          closeStream();
          return;
        }
        if (isMissingTurnEnded(error) && !finished && !isAborted(abortSignal)) {
          emitMissingTurnEnded(controller, closeReasoning, closeText, warnings, ctx.startWarningCount);
          closeStream();
          return;
        }
        const mapped = toProviderError(normalizeRunError(error, abortSignal));
        try {
          controller.enqueue({ type: "error", error: mapped });
        } catch {
          // controller already closed or errored
        }
        controller.error(mapped);
      } finally {
        abortSignal?.removeEventListener("abort", onAbort);
      }
    },
    cancel() {
      handle.abort();
    },
  });
}

function applyEvent(
  event: RunEvent,
  ctx: {
    abortHandle: () => void;
    advertisedTools: ReadonlySet<string>;
    closeReasoning: () => void;
    closeText: () => void;
    controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
    nextReasoningId: () => string;
    nextTextId: () => string;
    onFinish: () => void;
    reasoningId: () => string | undefined;
    startWarningCount: number;
    textId: () => string | undefined;
    warnings: SharedV3Warning[];
  },
): void {
  switch (event.type) {
    case "text_delta": {
      ctx.closeReasoning();
      let id = ctx.textId();
      if (id === undefined) {
        id = ctx.nextTextId();
        ctx.controller.enqueue({ type: "text-start", id });
      }
      ctx.controller.enqueue({ type: "text-delta", id, delta: event.text });
      break;
    }
    case "thinking_delta": {
      ctx.closeText();
      let id = ctx.reasoningId();
      if (id === undefined) {
        id = ctx.nextReasoningId();
        ctx.controller.enqueue({ type: "reasoning-start", id });
      }
      ctx.controller.enqueue({ type: "reasoning-delta", id, delta: event.text });
      break;
    }
    case "thinking_completed":
      ctx.closeReasoning();
      break;
    case "turn_ended":
      ctx.closeReasoning();
      ctx.closeText();
      ctx.onFinish();
      enqueueFinish(ctx.controller, mapUsage(event.usage), { unified: "stop", raw: "turn_ended" }, ctx.warnings, ctx.startWarningCount);
      break;
    case "mcp_exec":
      finishMcpExec(event, ctx);
      break;
    default:
      break;
  }
}

function isAdvertisedMcp(
  event: Extract<RunEvent, { type: "mcp_exec" }>,
  advertisedTools: ReadonlySet<string>,
): boolean {
  if (!advertisedTools.has(event.name)) {
    return false;
  }
  const provider = event.providerIdentifier?.trim();
  return provider === undefined || provider === "" || provider === "opencode";
}

function finishMcpExec(
  event: Extract<RunEvent, { type: "mcp_exec" }>,
  ctx: {
    abortHandle: () => void;
    advertisedTools: ReadonlySet<string>;
    closeReasoning: () => void;
    closeText: () => void;
    controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
    onFinish: () => void;
    startWarningCount: number;
    warnings: SharedV3Warning[];
  },
): void {
  ctx.closeReasoning();
  ctx.closeText();
  if (!isAdvertisedMcp(event, ctx.advertisedTools)) {
    ctx.abortHandle();
    throw new StreamError(`unadvertised mcp_exec for ${event.name}`);
  }
  const id = randomUUID();
  ctx.controller.enqueue({ type: "tool-input-start", id, toolName: event.name });
  ctx.controller.enqueue({ type: "tool-input-delta", id, delta: event.argumentsJson });
  ctx.controller.enqueue({ type: "tool-input-end", id });
  ctx.controller.enqueue({
    type: "tool-call",
    toolCallId: id,
    toolName: event.name,
    input: event.argumentsJson,
  });
  ctx.onFinish();
  enqueueFinish(ctx.controller, mapUsage(), { unified: "tool-calls", raw: "mcp_exec" }, ctx.warnings, ctx.startWarningCount);
  ctx.abortHandle();
}

function emitMissingTurnEnded(
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
  closeReasoning: () => void,
  closeText: () => void,
  warnings: SharedV3Warning[],
  startWarningCount: number,
): void {
  closeReasoning();
  closeText();
  const warning: SharedV3Warning = { type: "other", message: MISSING_TURN_ENDED };
  warnings.push(warning);
  enqueueFinish(controller, mapUsage(), { unified: "other", raw: MISSING_TURN_ENDED }, warnings, startWarningCount);
}

function mapUsage(usage: UsageCounts = {}): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: undefined,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: undefined,
      reasoning: usage.reasoningTokens,
    },
  };
}

function enqueueFinish(
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
  usage: LanguageModelV3Usage,
  finishReason: LanguageModelV3FinishReason,
  warnings: SharedV3Warning[],
  startWarningCount: number,
): void {
  const late = warnings.slice(startWarningCount);
  controller.enqueue({
    type: "finish",
    usage,
    finishReason,
    ...(late.length === 0
      ? {}
      : { providerMetadata: { cursor: { warnings: late as unknown as Array<Record<string, string>> } } }),
  });
}

function warningsFromFinish(part: Extract<LanguageModelV3StreamPart, { type: "finish" }>): SharedV3Warning[] {
  const raw = part.providerMetadata?.cursor?.warnings;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isSharedWarning);
}

function isSharedWarning(value: unknown): value is SharedV3Warning {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const type = value.type;
  if (type === "other" && "message" in value && typeof value.message === "string") {
    return true;
  }
  if ((type === "unsupported" || type === "compatibility") && "feature" in value && typeof value.feature === "string") {
    return true;
  }
  return false;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isMissingTurnEnded(error: unknown): boolean {
  return error instanceof StreamError && error.message === MISSING_TURN_ENDED;
}

function normalizeRunError(error: unknown, abortSignal: AbortSignal | undefined): unknown {
  if (abortSignal?.aborted === true) {
    return error instanceof CancelledError ? error : new CancelledError();
  }
  return error;
}
