import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ClientRunOptions, RunHandle, UsageCounts } from "cursor-rpc";
import {
  applyMappedError,
  HttpError,
  internalError,
  invalidRequestBodyError,
  invalidRequestError,
  isRecord,
  mapCursorError,
  openaiError,
  writeJson,
  type MappedCursorError,
  type UpstreamPin,
} from "../errors.js";
import type { ServerProvider } from "../provider.js";
import { modelNotFoundError, resolveCreateModel } from "./models.js";
import type { InsertResponseRow, ResponseStore } from "./response-store.js";
import { mapResponsesInput, rejectUnsupportedInputItems } from "./responses-input.js";
import {
  createResponsesSseWriter,
  writeResponsesReplay,
  writeResponsesSseHeaders,
  type ResponsesSseWriter,
} from "./responses-sse.js";

const RESPONSES_PREFIX = "/v1/responses/";
const CANCEL_SUFFIX = "/cancel";

export const responseNotFoundError = openaiError({
  message: "Response not found",
  type: "invalid_request_error",
  param: null,
  code: null,
});

export const compactUnsupportedError = openaiError({
  message: "Compaction and encrypted_content are unsupported",
  type: "invalid_request_error",
  param: "compact",
  code: "invalid_request_error",
});

export const cancelNotBackgroundError = openaiError({
  message: "Only responses created with background:true can be cancelled",
  type: "invalid_request_error",
  param: "response_id",
  code: "invalid_request_error",
});

const ASK_MODE = "ask" as const;
const ENTROPY_BYTES = 16;

type PreparedResponseCreate = {
  model: string;
  store: boolean;
  stream: boolean;
  instructions: string | null;
  previousResponseId: string | null;
  runOptions: ClientRunOptions;
  userText: string;
};

type ParsedCreateRequest = {
  input: unknown;
  model: string | undefined;
  instructions: string | undefined;
  store: boolean;
  stream: boolean;
  previousResponseId: string | undefined;
};

async function prepareResponseCreate(options: {
  body: unknown;
  provider: ServerProvider;
  store: ResponseStore;
}): Promise<PreparedResponseCreate> {
  const request = parseCreateRequest(options.body);
  const catalogue = await options.provider.models();
  const model = resolveCreateModel(catalogue, request.model);
  if (model === undefined) {
    throw new HttpError(404, modelNotFoundError(request.model));
  }
  const ancestorTranscripts =
    request.previousResponseId === undefined ? [] : options.store.loadAncestorChain(request.previousResponseId);
  const mapped = mapResponsesInput({
    input: request.input,
    instructions: request.instructions,
    ancestorTranscripts,
  });
  const runOptions: ClientRunOptions = {
    prompt: mapped.prompt,
    conversationHistory: mapped.conversationHistory,
    modelId: model,
    mode: ASK_MODE,
  };
  return {
    model,
    store: request.store,
    stream: request.stream,
    instructions: request.instructions ?? null,
    previousResponseId: request.previousResponseId ?? null,
    runOptions,
    userText: mapped.userText,
  };
}

export function responseIdFromPath(path: string): string | undefined {
  if (!path.startsWith(RESPONSES_PREFIX)) {
    return undefined;
  }
  return decodeURIComponent(path.slice(RESPONSES_PREFIX.length));
}

export function cancelResponseIdFromPath(path: string): string | undefined {
  if (!path.startsWith(RESPONSES_PREFIX) || !path.endsWith(CANCEL_SUFFIX)) {
    return undefined;
  }
  return decodeURIComponent(path.slice(RESPONSES_PREFIX.length, path.length - CANCEL_SUFFIX.length));
}

export function handleGetResponse(options: {
  res: ServerResponse;
  requestId: string;
  id: string;
  url: string;
  store: ResponseStore;
}): void {
  const stored = options.store.get(options.id);
  if (stored === undefined) {
    writeJson(options.res, 404, responseNotFoundError, options.requestId);
    return;
  }
  const query = parseRetrieveQuery(options.url);
  if (!query.stream) {
    writeJson(options.res, 200, stored, options.requestId);
    return;
  }
  writeResponsesReplay(options.res, options.requestId, replayEvents(stored), query.startingAfter);
}

export function handleDeleteResponse(options: {
  res: ServerResponse;
  requestId: string;
  id: string;
  store: ResponseStore;
}): void {
  if (!options.store.delete(options.id)) {
    writeJson(options.res, 404, responseNotFoundError, options.requestId);
    return;
  }
  writeJson(
    options.res,
    200,
    { id: options.id, object: "response", deleted: true },
    options.requestId,
  );
}

export function handleCancelResponse(options: {
  res: ServerResponse;
  requestId: string;
  id: string;
  store: ResponseStore;
}): void {
  if (!options.store.has(options.id)) {
    writeJson(options.res, 404, responseNotFoundError, options.requestId);
    return;
  }
  writeJson(options.res, 400, cancelNotBackgroundError, options.requestId);
}

export function handleCompactResponse(options: { res: ServerResponse; requestId: string }): void {
  writeJson(options.res, 400, compactUnsupportedError, options.requestId);
}

export async function handleCreateResponse(options: {
  res: ServerResponse;
  requestId: string;
  body: unknown;
  provider: ServerProvider;
  pin: UpstreamPin;
  store: ResponseStore;
}): Promise<void> {
  const prepared = await prepareResponseCreate({
    body: options.body,
    provider: options.provider,
    store: options.store,
  });
  const ids = mintIds();
  const createdAt = Math.floor(Date.now() / 1000);
  if (prepared.stream) {
    await handleCreateResponseStream({
      res: options.res,
      requestId: options.requestId,
      provider: options.provider,
      pin: options.pin,
      store: options.store,
      prepared,
      ids,
      createdAt,
    });
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
    handle = await options.provider.run({ ...prepared.runOptions, signal: abort.signal });
    const result = await handle.wait();
    if (abort.signal.aborted || options.res.writableEnded) {
      return;
    }
    const response = completedResponse({
      id: ids.responseId,
      messageId: ids.messageId,
      createdAt,
      model: prepared.model,
      text: result.text,
      usage: result.usage,
      instructions: prepared.instructions,
      store: prepared.store,
      previousResponseId: prepared.previousResponseId,
    });
    persistRow(options.store, {
      id: ids.responseId,
      status: "completed",
      previousResponseId: prepared.previousResponseId,
      model: prepared.model,
      instructions: prepared.instructions,
      store: prepared.store,
      createdAt,
      response,
      transcript: { user: prepared.userText, assistant: result.text },
    });
    writeJson(options.res, 200, response, options.requestId);
  } catch (error) {
    const mapped = mapCursorError(error);
    throw applyMappedError(mapped, options.pin);
  } finally {
    options.res.off("close", onClose);
  }
}

async function handleCreateResponseStream(options: {
  res: ServerResponse;
  requestId: string;
  provider: ServerProvider;
  pin: UpstreamPin;
  store: ResponseStore;
  prepared: PreparedResponseCreate;
  ids: { responseId: string; messageId: string };
  createdAt: number;
}): Promise<void> {
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
  let writer: ResponsesSseWriter | undefined;
  try {
    handle = await options.provider.run({ ...options.prepared.runOptions, signal: abort.signal });
    writeResponsesSseHeaders(options.res, options.requestId);
    writer = createResponsesSseWriter();
    const inProgress = inProgressResponse({
      id: options.ids.responseId,
      createdAt: options.createdAt,
      model: options.prepared.model,
      instructions: options.prepared.instructions,
      store: options.prepared.store,
      previousResponseId: options.prepared.previousResponseId,
    });
    writer.emit(options.res, { type: "response.created", response: inProgress });
    writer.emit(options.res, { type: "response.in_progress", response: inProgress });
    writer.emit(options.res, {
      type: "response.output_item.added",
      output_index: 0,
      item: assistantMessage(options.ids.messageId, "in_progress"),
    });
    writer.emit(options.res, {
      type: "response.content_part.added",
      item_id: options.ids.messageId,
      output_index: 0,
      content_index: 0,
      part: outputTextPart(""),
    });
    let text = "";
    let usage: UsageCounts | undefined;
    for await (const event of handle) {
      if (event.type === "turn_ended") {
        usage = event.usage;
        continue;
      }
      if (event.type !== "text_delta") {
        continue;
      }
      text += event.text;
      writer.emit(options.res, {
        type: "response.output_text.delta",
        item_id: options.ids.messageId,
        output_index: 0,
        content_index: 0,
        delta: event.text,
        logprobs: [],
      });
    }
    const completed = completedResponse({
      id: options.ids.responseId,
      messageId: options.ids.messageId,
      createdAt: options.createdAt,
      model: options.prepared.model,
      text,
      usage,
      instructions: options.prepared.instructions,
      store: options.prepared.store,
      previousResponseId: options.prepared.previousResponseId,
    });
    persistRow(options.store, {
      id: options.ids.responseId,
      status: "completed",
      previousResponseId: options.prepared.previousResponseId,
      model: options.prepared.model,
      instructions: options.prepared.instructions,
      store: options.prepared.store,
      createdAt: options.createdAt,
      response: completed,
      transcript: { user: options.prepared.userText, assistant: text },
    });
    writer.emit(options.res, {
      type: "response.output_text.done",
      item_id: options.ids.messageId,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    });
    writer.emit(options.res, {
      type: "response.content_part.done",
      item_id: options.ids.messageId,
      output_index: 0,
      content_index: 0,
      part: outputTextPart(text),
    });
    writer.emit(options.res, {
      type: "response.output_item.done",
      output_index: 0,
      item: assistantMessage(options.ids.messageId, "completed", text),
    });
    writer.emit(options.res, { type: "response.completed", response: completed });
    if (!options.res.writableEnded) {
      options.res.end();
    }
  } catch (error) {
    settleCreateStreamError({
      error,
      res: options.res,
      pin: options.pin,
      store: options.store,
      prepared: options.prepared,
      ids: options.ids,
      createdAt: options.createdAt,
      writer,
    });
  } finally {
    options.res.off("close", onClose);
  }
}

function settleCreateStreamError(options: {
  error: unknown;
  res: ServerResponse;
  pin: UpstreamPin;
  store: ResponseStore;
  prepared: PreparedResponseCreate;
  ids: { responseId: string; messageId: string };
  createdAt: number;
  writer: ResponsesSseWriter | undefined;
}): void {
  const mapped = mapCursorError(options.error);
  if (mapped.kind === "cancelled") {
    if (!options.res.writableEnded) {
      options.res.end();
    }
    return;
  }
  const httpError = applyMappedError(mapped, options.pin);
  persistFailed(options.store, options.prepared, options.ids.responseId, options.createdAt, httpError, mapped.kind);
  if (!options.res.headersSent) {
    throw httpError;
  }
  if (options.writer !== undefined) {
    emitStreamFailure(options.res, options.writer, options.ids, options.createdAt, options.prepared, httpError);
  }
  if (!options.res.writableEnded) {
    options.res.end();
  }
}

function emitStreamFailure(
  res: ServerResponse,
  writer: ResponsesSseWriter,
  ids: { responseId: string; messageId: string },
  createdAt: number,
  prepared: PreparedResponseCreate,
  httpError: HttpError,
): void {
  writer.emit(res, {
    type: "response.failed",
    response: failedResponse({
      id: ids.responseId,
      createdAt,
      model: prepared.model,
      instructions: prepared.instructions,
      store: prepared.store,
      previousResponseId: prepared.previousResponseId,
      error: httpError.body.error,
    }),
  });
  writer.emit(res, {
    type: "error",
    code: httpError.body.error.code,
    message: httpError.body.error.message,
    param: httpError.body.error.param,
  });
}

function parseRetrieveQuery(url: string): { stream: boolean; startingAfter?: number } {
  const parsed = new URL(url, "http://localhost");
  const startingAfterRaw = parsed.searchParams.get("starting_after");
  let startingAfter: number | undefined;
  if (startingAfterRaw !== null && /^-?\d+$/.test(startingAfterRaw)) {
    startingAfter = Number(startingAfterRaw);
  }
  return {
    stream: parsed.searchParams.get("stream") === "true",
    startingAfter,
  };
}

function replayEvents(stored: Record<string, unknown>): Array<{ type: string } & Record<string, unknown>> {
  if (stored.status === "failed") {
    const error = isRecord(stored.error) ? stored.error : {};
    return [
      { type: "response.failed", response: stored },
      {
        type: "error",
        code: typeof error.code === "string" ? error.code : null,
        message: typeof error.message === "string" ? error.message : "",
        param: typeof error.param === "string" ? error.param : null,
      },
    ];
  }
  const text = storedAssistantText(stored);
  const messageId = storedMessageId(stored);
  const inProgress = inProgressFromStored(stored);
  return [
    { type: "response.created", response: inProgress },
    { type: "response.in_progress", response: inProgress },
    { type: "response.output_item.added", output_index: 0, item: assistantMessage(messageId, "in_progress") },
    {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: outputTextPart(""),
    },
    {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: outputTextPart(text),
    },
    { type: "response.output_item.done", output_index: 0, item: assistantMessage(messageId, "completed", text) },
    { type: "response.completed", response: stored },
  ];
}

function storedAssistantText(stored: Record<string, unknown>): string {
  const output = stored.output;
  if (!Array.isArray(output)) {
    return "";
  }
  const texts: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const content = item.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("");
}

function storedMessageId(stored: Record<string, unknown>): string {
  const output = stored.output;
  if (Array.isArray(output) && isRecord(output[0]) && typeof output[0].id === "string") {
    return output[0].id;
  }
  const id = typeof stored.id === "string" ? stored.id : "replay";
  return id.startsWith("resp_") ? `msg_${id.slice("resp_".length)}` : `msg_${id}`;
}

function inProgressFromStored(stored: Record<string, unknown>): Record<string, unknown> {
  return inProgressResponse({
    id: typeof stored.id === "string" ? stored.id : "",
    createdAt: typeof stored.created_at === "number" ? stored.created_at : 0,
    model: typeof stored.model === "string" ? stored.model : "",
    instructions: typeof stored.instructions === "string" ? stored.instructions : null,
    store: stored.store !== false,
    previousResponseId: typeof stored.previous_response_id === "string" ? stored.previous_response_id : null,
  });
}

function parseCreateRequest(body: unknown): ParsedCreateRequest {
  if (!isRecord(body)) {
    throw invalidRequestBodyError;
  }
  rejectUnsupported(body);
  rejectUnsupportedInputItems(body.input);
  return {
    input: body.input,
    model: typeof body.model === "string" ? body.model : undefined,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    store: body.store !== false,
    stream: body.stream === true,
    previousResponseId:
      typeof body.previous_response_id === "string" && body.previous_response_id.length > 0
        ? body.previous_response_id
        : undefined,
  };
}

function rejectUnsupported(body: Record<string, unknown>): void {
  if (body.conversation !== undefined && body.conversation !== null) {
    throw unsupported("conversation", "Conversations are not supported");
  }
  if (body.background === true) {
    throw unsupported("background", "Background responses are not supported");
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw unsupported("tools", "Tool calling is not supported");
  }
  if (body.text !== undefined && body.text !== null) {
    const format = isRecord(body.text) ? body.text.format : undefined;
    if (format !== undefined && format !== null && (!isRecord(format) || format.type !== "text")) {
      throw unsupported("text", "Only text.format type text is supported");
    }
  }
}

function mintIds(): { responseId: string; messageId: string } {
  const entropy = randomBytes(ENTROPY_BYTES).toString("hex");
  return {
    responseId: `resp_${entropy}`,
    messageId: `msg_${entropy}`,
  };
}

function completedResponse(options: {
  id: string;
  messageId: string;
  createdAt: number;
  model: string;
  text: string;
  usage: UsageCounts | undefined;
  instructions: string | null;
  store: boolean;
  previousResponseId: string | null;
}): Record<string, unknown> {
  return {
    id: options.id,
    object: "response",
    created_at: options.createdAt,
    status: "completed",
    model: options.model,
    output: [assistantMessage(options.messageId, "completed", options.text)],
    usage: toUsage(options.usage),
    instructions: options.instructions,
    store: options.store,
    previous_response_id: options.previousResponseId,
    error: null,
    incomplete_details: null,
    tools: [],
    text: { format: { type: "text" } },
  };
}

function inProgressResponse(options: {
  id: string;
  createdAt: number;
  model: string;
  instructions: string | null;
  store: boolean;
  previousResponseId: string | null;
}): Record<string, unknown> {
  return {
    id: options.id,
    object: "response",
    created_at: options.createdAt,
    status: "in_progress",
    model: options.model,
    output: [],
    usage: null,
    instructions: options.instructions,
    store: options.store,
    previous_response_id: options.previousResponseId,
    error: null,
    incomplete_details: null,
    tools: [],
    text: { format: { type: "text" } },
  };
}

function failedResponse(options: {
  id: string;
  createdAt: number;
  model: string;
  instructions: string | null;
  store: boolean;
  previousResponseId: string | null;
  error: { message: string; type: string; param: string | null; code: string | null };
}): Record<string, unknown> {
  return {
    id: options.id,
    object: "response",
    created_at: options.createdAt,
    status: "failed",
    model: options.model,
    output: [],
    usage: toUsage(undefined),
    instructions: options.instructions,
    store: options.store,
    previous_response_id: options.previousResponseId,
    error: options.error,
    incomplete_details: null,
    tools: [],
    text: { format: { type: "text" } },
  };
}

function assistantMessage(
  id: string,
  status: "in_progress" | "completed",
  text?: string,
): Record<string, unknown> {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: text === undefined ? [] : [outputTextPart(text)],
  };
}

function outputTextPart(text: string): { type: "output_text"; text: string; annotations: unknown[] } {
  return { type: "output_text", text, annotations: [] };
}

function persistRow(store: ResponseStore, row: InsertResponseRow): void {
  try {
    store.insert(row);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new HttpError(500, internalError);
    }
    throw error;
  }
}

function persistFailed(
  store: ResponseStore,
  prepared: PreparedResponseCreate,
  id: string,
  createdAt: number,
  httpError: HttpError,
  kind: MappedCursorError["kind"],
): void {
  if (kind === "cancelled" || !prepared.store) {
    return;
  }
  try {
    persistRow(store, {
      id,
      status: "failed",
      previousResponseId: prepared.previousResponseId,
      model: prepared.model,
      instructions: prepared.instructions,
      store: prepared.store,
      createdAt,
      response: failedResponse({
        id,
        createdAt,
        model: prepared.model,
        instructions: prepared.instructions,
        store: prepared.store,
        previousResponseId: prepared.previousResponseId,
        error: httpError.body.error,
      }),
      transcript: { user: prepared.userText, assistant: "" },
    });
  } catch {
    // Keep the Cursor-mapped HTTP status as the client outcome.
  }
}

function unsupported(param: string, message: string): HttpError {
  return invalidRequestError(param, message);
}

function toUsage(usage: UsageCounts | undefined): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
  };
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}
