import type { ServerResponse } from "node:http";
import { HttpError, openaiError, writeJson } from "../errors.js";
import type { ListChatCompletionsQuery, ResponseStore } from "./response-store.js";

const MAX_METADATA_KEYS = 16;
const MAX_METADATA_KEY_CHARS = 64;
const MAX_METADATA_VALUE_CHARS = 512;
const CHAT_COMPLETIONS_PREFIX = "/v1/chat/completions/";

export const chatCompletionNotFoundError = openaiError({
  message: "Chat completion not found",
  type: "invalid_request_error",
  param: null,
  code: null,
});

export function parseCreateStore(body: Record<string, unknown>): {
  store: boolean;
  metadata: Record<string, string> | null;
} {
  if (body.store !== true) {
    return { store: false, metadata: null };
  }
  if (body.metadata === undefined) {
    return { store: true, metadata: {} };
  }
  return { store: true, metadata: parseStoredMetadata(body.metadata) };
}

export function parseStoredMetadata(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw paramError("metadata", "Invalid metadata");
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) {
    throw paramError("metadata", "Invalid metadata");
  }
  const metadata: Record<string, string> = {};
  for (const key of keys) {
    const item = value[key];
    if (key.length > MAX_METADATA_KEY_CHARS || typeof item !== "string" || item.length > MAX_METADATA_VALUE_CHARS) {
      throw paramError("metadata", "Invalid metadata");
    }
    metadata[key] = item;
  }
  return metadata;
}

export function chatCompletionIdFromPath(path: string): string | undefined {
  if (!path.startsWith(CHAT_COMPLETIONS_PREFIX)) {
    return undefined;
  }
  return decodeURIComponent(path.slice(CHAT_COMPLETIONS_PREFIX.length));
}

export function parseListQuery(url: string): ListChatCompletionsQuery {
  const parsed = new URL(url, "http://localhost");
  const query: ListChatCompletionsQuery = {};
  const after = parsed.searchParams.get("after");
  if (after !== null) {
    query.after = after;
  }
  const limit = parsed.searchParams.get("limit");
  if (limit !== null) {
    if (!/^-?\d+$/.test(limit)) {
      throw paramError("limit", "Invalid limit");
    }
    query.limit = Number(limit);
  }
  const model = parsed.searchParams.get("model");
  if (model !== null) {
    query.model = model;
  }
  const order = parsed.searchParams.get("order");
  if (order !== null) {
    query.order = order;
  }
  const metadata: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) {
    const match = /^metadata\[(.*)\]$/.exec(key);
    if (match?.[1] !== undefined) {
      metadata[match[1]] = value;
    }
  }
  if (Object.keys(metadata).length > 0) {
    query.metadata = metadata;
  }
  return query;
}

export function handleListStoredCompletions(options: {
  res: ServerResponse;
  requestId: string;
  url: string;
  store: ResponseStore;
}): void {
  writeJson(options.res, 200, options.store.listChat(parseListQuery(options.url)), options.requestId);
}

export function handleGetStoredCompletion(options: {
  res: ServerResponse;
  requestId: string;
  id: string;
  store: ResponseStore;
}): void {
  const stored = options.store.getChat(options.id);
  if (stored === undefined) {
    writeJson(options.res, 404, chatCompletionNotFoundError, options.requestId);
    return;
  }
  writeJson(options.res, 200, stored, options.requestId);
}

export function handleUpdateStoredCompletion(options: {
  res: ServerResponse;
  requestId: string;
  id: string;
  body: unknown;
  store: ResponseStore;
}): void {
  if (!isRecord(options.body)) {
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
  if (!Object.hasOwn(options.body, "metadata")) {
    handleGetStoredCompletion(options);
    return;
  }
  const metadata = options.body.metadata === null ? null : parseStoredMetadata(options.body.metadata);
  const updated = options.store.updateChatMetadata(options.id, metadata);
  if (updated === undefined) {
    writeJson(options.res, 404, chatCompletionNotFoundError, options.requestId);
    return;
  }
  writeJson(options.res, 200, updated, options.requestId);
}

export function handleDeleteStoredCompletion(options: {
  res: ServerResponse;
  requestId: string;
  id: string;
  store: ResponseStore;
}): void {
  if (!options.store.deleteChat(options.id)) {
    writeJson(options.res, 404, chatCompletionNotFoundError, options.requestId);
    return;
  }
  writeJson(
    options.res,
    200,
    { id: options.id, deleted: true, object: "chat.completion.deleted" },
    options.requestId,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function paramError(param: string, message: string): HttpError {
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
