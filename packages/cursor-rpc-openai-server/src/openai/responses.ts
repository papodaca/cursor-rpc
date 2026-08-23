import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ClientRunOptions, UsageCounts } from "cursor-rpc";
import { HttpError, internalError, mapCursorError, openaiError, writeJson, type MappedCursorError } from "../errors.js";
import type { ServerProvider } from "../provider.js";
import { modelNotFoundError, resolveCreateModel } from "./models.js";
import type { InsertResponseRow, ResponseStore } from "./response-store.js";
import { mapResponsesInput, rejectUnsupportedInputItems } from "./responses-input.js";

const ASK_MODE = "ask" as const;
const ENTROPY_BYTES = 16;

export type ResponsesPin = {
  error?: HttpError;
};

export type PreparedResponseCreate = {
  model: string;
  store: boolean;
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
  previousResponseId: string | undefined;
};

export async function prepareResponseCreate(options: {
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
    instructions: request.instructions ?? null,
    previousResponseId: request.previousResponseId ?? null,
    runOptions,
    userText: mapped.userText,
  };
}

export async function handleCreateResponse(options: {
  res: ServerResponse;
  requestId: string;
  body: unknown;
  provider: ServerProvider;
  pin: ResponsesPin;
  store: ResponseStore;
}): Promise<void> {
  const prepared = await prepareResponseCreate({
    body: options.body,
    provider: options.provider,
    store: options.store,
  });
  const ids = mintIds();
  const createdAt = Math.floor(Date.now() / 1000);
  let text: string;
  let usage: UsageCounts;
  try {
    const handle = await options.provider.run(prepared.runOptions);
    const result = await handle.wait();
    text = result.text;
    usage = result.usage;
  } catch (error) {
    const mapped = mapCursorError(error);
    const httpError = applyMappedError(mapped, options.pin);
    persistFailed(options.store, prepared, ids.responseId, createdAt, httpError, mapped.kind);
    throw httpError;
  }
  const response = completedResponse({
    id: ids.responseId,
    messageId: ids.messageId,
    createdAt,
    model: prepared.model,
    text,
    usage,
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
    transcript: { user: prepared.userText, assistant: text },
  });
  writeJson(options.res, 200, response, options.requestId);
}

function parseCreateRequest(body: unknown): ParsedCreateRequest {
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
  rejectUnsupported(body);
  rejectUnsupportedInputItems(body.input);
  return {
    input: body.input,
    model: typeof body.model === "string" ? body.model : undefined,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    store: body.store !== false,
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
    if (isRecord(body.text) && body.text.format !== undefined && body.text.format !== null) {
      if (!isRecord(body.text.format) || body.text.format.type !== "text") {
        throw unsupported("text", "Only text.format type text is supported");
      }
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
    output: [
      {
        id: options.messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: options.text, annotations: [] }],
      },
    ],
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
      response: {
        id,
        object: "response",
        created_at: createdAt,
        status: "failed",
        model: prepared.model,
        output: [],
        usage: toUsage(undefined),
        instructions: prepared.instructions,
        store: prepared.store,
        previous_response_id: prepared.previousResponseId,
        error: httpError.body.error,
        incomplete_details: null,
        tools: [],
        text: { format: { type: "text" } },
      },
      transcript: { user: prepared.userText, assistant: "" },
    });
  } catch {
    // Keep the Cursor-mapped HTTP status as the client outcome.
  }
}

function applyMappedError(mapped: MappedCursorError, pin: ResponsesPin): HttpError {
  if (mapped.kind === "cancelled") {
    return new HttpError(
      499,
      openaiError({
        message: "cancelled",
        type: "api_error",
        param: null,
        code: "cancelled",
      }),
    );
  }
  if (mapped.pin) {
    pin.error = mapped.error;
  }
  return mapped.error;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
