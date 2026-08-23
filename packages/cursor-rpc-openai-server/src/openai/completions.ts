import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ClientRunOptions, RunHandle, UsageCounts } from "cursor-rpc";
import { HttpError, mapCursorError, openaiError, writeJson, type MappedCursorError } from "../errors.js";
import type { ServerProvider } from "../provider.js";
import { mapMessages } from "./messages.js";
import { modelNotFoundError, resolveCreateModel } from "./models.js";
import type { ResponseStore } from "./response-store.js";
import { completionChunk, writeSseData, writeSseDone, writeSseHeaders, type Usage } from "./sse.js";
import { parseCreateStore } from "./stored-completions.js";

export type UpstreamPin = {
  error?: HttpError;
};

export async function handleChatCompletion(options: {
  res: ServerResponse;
  requestId: string;
  body: unknown;
  provider: ServerProvider;
  pin: UpstreamPin;
  store: ResponseStore;
}): Promise<void> {
  const request = parseCreateRequest(options.body);
  const mapped = mapMessages(request.messages);
  const catalogue = await runPinned(options.pin, () => options.provider.models());
  const model = resolveCreateModel(catalogue, request.model);
  if (model === undefined) {
    throw new HttpError(404, modelNotFoundError(request.model));
  }
  const runOptions: ClientRunOptions = {
    prompt: mapped.prompt,
    conversationHistory: mapped.conversationHistory,
    modelId: model,
    mode: "ask",
  };
  if (!request.stream) {
    const handle = await options.provider.run(runOptions);
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const result = await handle.wait();
    const completion = chatCompletionObject({
      id,
      created,
      model,
      text: result.text,
      usage: result.usage,
    });
    persistStoredCompletion(options.store, request, completion);
    writeJson(options.res, 200, completion, options.requestId);
    return;
  }

  const abort = new AbortController();
  let handle: RunHandle | undefined;
  const onClose = () => {
    if (!options.res.writableFinished) {
      abort.abort();
      handle?.abort();
    }
  };
  options.res.once("close", onClose);
  if (options.res.destroyed) {
    onClose();
  }
  try {
    handle = await options.provider.run({ ...runOptions, signal: abort.signal });
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    writeSseHeaders(options.res, options.requestId);
    let roleSent = false;
    let text = "";
    let usage: UsageCounts = {};
    for await (const event of handle) {
      if (event.type === "turn_ended") {
        usage = event.usage;
        continue;
      }
      if (event.type !== "text_delta") {
        continue;
      }
      text += event.text;
      const delta: { role?: "assistant"; content: string } = { content: event.text };
      if (!roleSent) {
        delta.role = "assistant";
        roleSent = true;
      }
      writeSseData(
        options.res,
        completionChunk(id, created, model, [{ index: 0, delta, finish_reason: null }]),
      );
    }
    if (!roleSent) {
      writeSseData(
        options.res,
        completionChunk(id, created, model, [
          { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
        ]),
      );
    }
    writeSseData(
      options.res,
      completionChunk(id, created, model, [{ index: 0, delta: {}, finish_reason: "stop" }]),
    );
    if (request.includeUsage) {
      writeSseData(options.res, completionChunk(id, created, model, [], toUsage(usage)));
    }
    writeSseDone(options.res);
    persistStoredCompletion(
      options.store,
      request,
      chatCompletionObject({ id, created, model, text, usage }),
    );
    options.res.end();
  } catch (error) {
    await settleStreamError(error, options.res, options.requestId, options.pin);
  } finally {
    options.res.off("close", onClose);
  }
}

function applyMappedError(mapped: MappedCursorError, pin: UpstreamPin): HttpError {
  if (mapped.kind === "cancelled") {
    return new HttpError(499, openaiError({ message: "cancelled", type: "api_error", param: null, code: "cancelled" }));
  }
  if (mapped.pin) {
    pin.error = mapped.error;
  }
  return mapped.error;
}

export async function runPinned<T>(pin: UpstreamPin, operation: () => Promise<T>): Promise<T> {
  if (pin.error !== undefined) {
    throw pin.error;
  }
  try {
    return await operation();
  } catch (error) {
    throw applyMappedError(mapCursorError(error), pin);
  }
}

async function settleStreamError(
  error: unknown,
  res: ServerResponse,
  requestId: string,
  pin: UpstreamPin,
): Promise<void> {
  const mapped = mapCursorError(error);
  if (mapped.kind === "cancelled") {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }
  const httpError = applyMappedError(mapped, pin);
  if (!res.headersSent) {
    writeJson(res, httpError.status, httpError.body, requestId);
    return;
  }
  writeSseData(res, httpError.body);
  if (!res.writableEnded) {
    res.end();
  }
}

type CreateRequest = {
  messages: unknown;
  model: string | undefined;
  stream: boolean;
  includeUsage: boolean;
  store: boolean;
  metadata: Record<string, string> | null;
};

type ChatCompletionObject = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop";
  }>;
  usage: Usage;
};

function parseCreateRequest(body: unknown): CreateRequest {
  if (!isRecord(body)) {
    throw new HttpError(
      400,
      openaiError({
        message: "Invalid request body",
        type: "invalid_request_error",
        param: null,
        code: "invalid_request_error",
      }),
    );
  }
  const record = body;
  rejectUnsupported(record);
  const stored = parseCreateStore(record);
  return {
    messages: record.messages,
    model: typeof record.model === "string" ? record.model : undefined,
    stream: record.stream === true,
    includeUsage:
      record.stream === true &&
      isRecord(record.stream_options) &&
      record.stream_options.include_usage === true,
    store: stored.store,
    metadata: stored.metadata,
  };
}

function chatCompletionObject(options: {
  id: string;
  created: number;
  model: string;
  text: string;
  usage: UsageCounts | undefined;
}): ChatCompletionObject {
  return {
    id: options.id,
    object: "chat.completion",
    created: options.created,
    model: options.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: options.text },
        finish_reason: "stop",
      },
    ],
    usage: toUsage(options.usage),
  };
}

function persistStoredCompletion(
  store: ResponseStore,
  request: CreateRequest,
  completion: ChatCompletionObject,
): void {
  if (!request.store) {
    return;
  }
  store.insertChat({
    id: completion.id,
    created: completion.created,
    model: completion.model,
    metadata: request.metadata,
    body: completion,
  });
}

function rejectUnsupported(body: Record<string, unknown>): void {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw unsupported("tools", "Tool calling is not supported");
  }
  if (Array.isArray(body.functions) && body.functions.length > 0) {
    throw unsupported("functions", "Function calling is not supported");
  }
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    throw unsupported("n", "Only n=1 is supported");
  }
  if (body.response_format !== undefined && body.response_format !== null) {
    if (!isRecord(body.response_format) || body.response_format.type !== "text") {
      throw unsupported("response_format", "Only response_format type text is supported");
    }
  }
}

function unsupported(param: string, message: string): HttpError {
  return new HttpError(
    400,
    openaiError({
      message,
      type: "invalid_request_error",
      param,
      code: "invalid_request_error",
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toUsage(usage: UsageCounts | undefined): Usage {
  const prompt = usage?.inputTokens ?? 0;
  const completion = usage?.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}
