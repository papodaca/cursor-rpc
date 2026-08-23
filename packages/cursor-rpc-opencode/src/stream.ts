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
  type RunEvent,
  type RunHandle,
  type UsageCounts,
} from "cursor-rpc";
import { mapPrompt } from "./prompt.js";

const MISSING_TURN_ENDED = "stream ended without turn_ended";

const UNSUPPORTED_SAMPLING = [
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "maxOutputTokens",
  "stopSequences",
  "seed",
  "tools",
  "toolChoice",
] as const satisfies ReadonlyArray<keyof LanguageModelV3CallOptions>;

export function toProviderError(error: unknown): APICallError {
  const message =
    error instanceof CursorRpcError || error instanceof Error ? error.message : "unknown error";
  return new APICallError({
    message,
    url: "cursor-rpc",
    requestBodyValues: {},
    isRetryable: error instanceof CursorRpcError ? error.isRetryable : false,
  });
}

export async function streamCursorRun(options: {
  client: CursorRpcClient;
  modelId: string;
  call: LanguageModelV3CallOptions;
}): Promise<LanguageModelV3StreamResult> {
  const mapped = mapPrompt(options.call.prompt);
  const warnings = [...callWarnings(options.call), ...mapped.warnings];
  const runOptions = clientRunOptions(options.modelId, options.call.abortSignal, mapped);

  let handle: RunHandle;
  try {
    handle = await options.client.run(runOptions);
  } catch (error) {
    throw toProviderError(normalizeRunError(error, options.call.abortSignal));
  }

  return {
    stream: pumpHandle(handle, options.call.abortSignal, warnings),
  };
}

export async function consumeCursorStream(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3GenerateResult> {
  const reader = stream.getReader();
  const content: LanguageModelV3Content[] = [];
  const warnings: SharedV3Warning[] = [];
  const texts = new Map<string, string>();
  const reasonings = new Map<string, string>();
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
        case "text-delta":
          texts.set(part.id, (texts.get(part.id) ?? "") + part.delta);
          break;
        case "text-end":
          content.push({ type: "text", text: texts.get(part.id) ?? "" });
          break;
        case "reasoning-delta":
          reasonings.set(part.id, (reasonings.get(part.id) ?? "") + part.delta);
          break;
        case "reasoning-end":
          content.push({ type: "reasoning", text: reasonings.get(part.id) ?? "" });
          break;
        case "finish":
          finishReason = part.finishReason;
          usage = part.usage;
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
  signal: AbortSignal | undefined,
  mapped: ReturnType<typeof mapPrompt>,
): ClientRunOptions {
  const options: ClientRunOptions = {
    prompt: mapped.prompt,
    modelId,
  };
  if (signal !== undefined) {
    options.signal = signal;
  }
  if (mapped.customSystemPrompt !== undefined) {
    options.customSystemPrompt = mapped.customSystemPrompt;
  }
  if (mapped.conversationHistory !== undefined) {
    options.conversationHistory = mapped.conversationHistory;
  }
  return options;
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
): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream<LanguageModelV3StreamPart>({
    async start(controller) {
      const onAbort = (): void => {
        handle.abort();
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      controller.enqueue({ type: "stream-start", warnings });

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

      try {
        for await (const event of handle) {
          if (abortSignal?.aborted === true) {
            throw new CancelledError();
          }
          applyEvent(event, {
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
            textId: () => textId,
          });
        }
        if (!finished) {
          if (abortSignal?.aborted === true) {
            throw new CancelledError();
          }
          emitMissingTurnEnded(controller, closeReasoning, closeText, warnings);
        }
        controller.close();
      } catch (error) {
        if (isMissingTurnEnded(error) && !finished && abortSignal?.aborted !== true) {
          emitMissingTurnEnded(controller, closeReasoning, closeText, warnings);
          controller.close();
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
    closeReasoning: () => void;
    closeText: () => void;
    controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
    nextReasoningId: () => string;
    nextTextId: () => string;
    onFinish: () => void;
    reasoningId: () => string | undefined;
    textId: () => string | undefined;
  },
): void {
  switch (event.type) {
    case "text_delta":
      ctx.closeReasoning();
      if (ctx.textId() === undefined) {
        ctx.controller.enqueue({ type: "text-start", id: ctx.nextTextId() });
      }
      ctx.controller.enqueue({ type: "text-delta", id: ctx.textId() ?? ctx.nextTextId(), delta: event.text });
      break;
    case "thinking_delta":
      ctx.closeText();
      if (ctx.reasoningId() === undefined) {
        ctx.controller.enqueue({ type: "reasoning-start", id: ctx.nextReasoningId() });
      }
      ctx.controller.enqueue({
        type: "reasoning-delta",
        id: ctx.reasoningId() ?? ctx.nextReasoningId(),
        delta: event.text,
      });
      break;
    case "thinking_completed":
      ctx.closeReasoning();
      break;
    case "turn_ended":
      ctx.closeReasoning();
      ctx.closeText();
      ctx.onFinish();
      ctx.controller.enqueue({
        type: "finish",
        usage: mapUsage(event.usage),
        finishReason: { unified: "stop", raw: "turn_ended" },
      });
      break;
    default:
      break;
  }
}

function emitMissingTurnEnded(
  controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
  closeReasoning: () => void,
  closeText: () => void,
  warnings: SharedV3Warning[],
): void {
  closeReasoning();
  closeText();
  const warning: SharedV3Warning = { type: "other", message: MISSING_TURN_ENDED };
  warnings.push(warning);
  controller.enqueue({ type: "stream-start", warnings: [warning] });
  controller.enqueue({
    type: "finish",
    usage: mapUsage(),
    finishReason: { unified: "other", raw: MISSING_TURN_ENDED },
  });
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

function isMissingTurnEnded(error: unknown): boolean {
  return error instanceof StreamError && error.message === MISSING_TURN_ENDED;
}

function normalizeRunError(error: unknown, abortSignal: AbortSignal | undefined): unknown {
  if (abortSignal?.aborted === true) {
    return error instanceof CancelledError ? error : new CancelledError();
  }
  return error;
}
