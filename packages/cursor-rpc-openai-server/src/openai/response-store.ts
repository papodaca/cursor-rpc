import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeResponsesDbPath } from "../config.js";
import { HttpError, openaiError } from "../errors.js";

export const SQLITE_BUSY_TIMEOUT_MS = 5000;
const SCHEMA_USER_VERSION = 2;
const MAX_CHAIN_HOPS = 100;
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;
const MAX_METADATA_KEYS = 16;
const MAX_METADATA_KEY_CHARS = 64;
const MAX_METADATA_VALUE_CHARS = 512;

const RESPONSES_DDL = `CREATE TABLE responses (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
    previous_response_id TEXT,
    model TEXT NOT NULL,
    instructions TEXT,
    store INTEGER NOT NULL CHECK (store IN (0, 1)),
    created_at INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    transcript_json TEXT NOT NULL
  )`;

const CHAT_COMPLETIONS_DDL = `CREATE TABLE IF NOT EXISTS chat_completions (
    id TEXT PRIMARY KEY,
    created INTEGER,
    model TEXT,
    metadata TEXT,
    body TEXT
  )`;

export type ResponseStatus = "completed" | "failed";

export type ResponseTranscript = {
  user: string;
  assistant: string;
};

export type InsertResponseRow = {
  id: string;
  status: ResponseStatus;
  previousResponseId: string | null;
  model: string;
  instructions: string | null;
  store: boolean;
  createdAt: number;
  response: Record<string, unknown>;
  transcript: ResponseTranscript;
};

export type InsertChatCompletionRow = {
  id: string;
  created: number;
  model: string;
  metadata: Record<string, string> | null;
  body: Record<string, unknown>;
};

export type ListChatCompletionsQuery = {
  after?: string;
  limit?: number;
  model?: string;
  order?: string;
  metadata?: Record<string, string>;
};

export type ChatCompletionListPage = {
  object: "list";
  data: Record<string, unknown>[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
};

export type ResponseStore = {
  readonly path: string;
  insert(row: InsertResponseRow): void;
  get(id: string): Record<string, unknown> | undefined;
  delete(id: string): boolean;
  loadAncestorChain(previousResponseId: string): ResponseTranscript[];
  insertChat(row: InsertChatCompletionRow): void;
  getChat(id: string): Record<string, unknown> | undefined;
  listChat(query?: ListChatCompletionsQuery): ChatCompletionListPage;
  updateChatMetadata(id: string, metadata: Record<string, string> | null): Record<string, unknown> | undefined;
  deleteChat(id: string): boolean;
  close(): void;
};

export function buildListChatCompletionsSql(options: {
  metadataFilterCount: number;
  hasAfter: boolean;
  hasModel: boolean;
  order: "asc" | "desc";
}): string {
  const direction = options.order === "desc" ? "DESC" : "ASC";
  const cmp = options.order === "desc" ? "<" : ">";
  const clauses = ["SELECT id, metadata, body FROM chat_completions WHERE 1 = 1"];
  if (options.hasModel) {
    clauses.push("AND model = ?");
  }
  for (let i = 0; i < options.metadataFilterCount; i += 1) {
    clauses.push(
      "AND EXISTS (SELECT 1 FROM json_each(metadata) WHERE json_each.key = ? AND json_each.value = ?)",
    );
  }
  if (options.hasAfter) {
    clauses.push(`AND (created ${cmp} ? OR (created = ? AND id ${cmp} ?))`);
  }
  clauses.push(`ORDER BY created ${direction}, id ${direction}`);
  clauses.push("LIMIT ?");
  return clauses.join(" ");
}

type StoredRow = {
  status: ResponseStatus;
  previous_response_id: string | null;
  transcript_json: string;
};

export function openResponseStore(dbPath: string): ResponseStore {
  const path = normalizeResponsesDbPath(dbPath);
  if (path !== ":memory:") {
    prepareSecretFile(path);
  }
  const db = new DatabaseSync(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    if (path !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
      lockDownSidecars(path);
    }
    applySchema(db);
  } catch (error) {
    db.close();
    throw error;
  }

  const insertStmt = db.prepare(`INSERT INTO responses (
    id, status, previous_response_id, model, instructions, store, created_at, response_json, transcript_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const getProjectionStmt = db.prepare("SELECT response_json FROM responses WHERE id = ?");
  const deleteStmt = db.prepare("DELETE FROM responses WHERE id = ?");
  const getChainStmt = db.prepare(
    "SELECT status, previous_response_id, transcript_json FROM responses WHERE id = ?",
  );
  const insertChatStmt = db.prepare(
    "INSERT INTO chat_completions (id, created, model, metadata, body) VALUES (?, ?, ?, ?, ?)",
  );
  const getChatStmt = db.prepare("SELECT metadata, body FROM chat_completions WHERE id = ?");
  const getChatCursorStmt = db.prepare("SELECT created, id FROM chat_completions WHERE id = ?");
  const updateChatMetadataStmt = db.prepare("UPDATE chat_completions SET metadata = ? WHERE id = ?");
  const deleteChatStmt = db.prepare("DELETE FROM chat_completions WHERE id = ?");

  let closed = false;
  return {
    path,
    insert(row: InsertResponseRow): void {
      if (!row.store) {
        return;
      }
      insertStmt.run(
        row.id,
        row.status,
        row.previousResponseId,
        row.model,
        row.instructions,
        1,
        row.createdAt,
        JSON.stringify(row.response),
        JSON.stringify(row.transcript),
      );
    },
    get(id: string): Record<string, unknown> | undefined {
      const row = getProjectionStmt.get(id) as { response_json: string } | undefined;
      if (row === undefined) {
        return undefined;
      }
      return JSON.parse(row.response_json) as Record<string, unknown>;
    },
    delete(id: string): boolean {
      return deleteStmt.run(id).changes > 0;
    },
    loadAncestorChain(previousResponseId: string): ResponseTranscript[] {
      const visited = new Set<string>();
      const collected: ResponseTranscript[] = [];
      let current: string | null = previousResponseId;
      let hops = 0;
      while (current !== null) {
        hops += 1;
        if (hops > MAX_CHAIN_HOPS || visited.has(current)) {
          throw previousResponseIdError();
        }
        visited.add(current);
        const row = getChainStmt.get(current) as StoredRow | undefined;
        if (row === undefined || row.status !== "completed") {
          throw previousResponseIdError();
        }
        collected.push(JSON.parse(row.transcript_json) as ResponseTranscript);
        current = row.previous_response_id;
      }
      return collected.reverse();
    },
    insertChat(row: InsertChatCompletionRow): void {
      insertChatStmt.run(row.id, row.created, row.model, serializeMetadata(row.metadata), JSON.stringify(row.body));
    },
    getChat(id: string): Record<string, unknown> | undefined {
      const row = getChatStmt.get(id) as ChatStoredRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      return overlayChatRow(row);
    },
    listChat(query: ListChatCompletionsQuery = {}): ChatCompletionListPage {
      const limit = resolveListLimit(query.limit);
      const order = resolveListOrder(query.order);
      const metadataFilters = Object.entries(query.metadata ?? {});
      const hasModel = query.model !== undefined;
      let afterCreated: number | undefined;
      let afterId: string | undefined;
      if (query.after !== undefined) {
        const cursor = getChatCursorStmt.get(query.after) as { created: number; id: string } | undefined;
        if (cursor === undefined) {
          throw paramError("after", "Invalid after");
        }
        afterCreated = cursor.created;
        afterId = cursor.id;
      }
      const sql = buildListChatCompletionsSql({
        metadataFilterCount: metadataFilters.length,
        hasAfter: afterId !== undefined,
        hasModel,
        order,
      });
      const params: Array<string | number> = [];
      if (hasModel && query.model !== undefined) {
        params.push(query.model);
      }
      for (const [key, value] of metadataFilters) {
        params.push(key, value);
      }
      if (afterCreated !== undefined && afterId !== undefined) {
        params.push(afterCreated, afterCreated, afterId);
      }
      params.push(limit + 1);
      const rows = db.prepare(sql).all(...params) as ChatStoredRow[];
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit).map((row) => overlayChatRow(row));
      return {
        object: "list",
        data: page,
        first_id: page[0]?.id === undefined ? null : String(page[0].id),
        last_id: page.length === 0 ? null : String(page[page.length - 1]?.id),
        has_more: hasMore,
      };
    },
    updateChatMetadata(id: string, metadata: Record<string, string> | null): Record<string, unknown> | undefined {
      const result = updateChatMetadataStmt.run(serializeMetadata(metadata), id);
      if (result.changes === 0) {
        return undefined;
      }
      const row = getChatStmt.get(id) as ChatStoredRow | undefined;
      return row === undefined ? undefined : overlayChatRow(row);
    },
    deleteChat(id: string): boolean {
      return deleteChatStmt.run(id).changes > 0;
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      db.close();
    },
  };
}

function applySchema(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version === SCHEMA_USER_VERSION) {
    return;
  }
  if (version === 0) {
    runInTransaction(db, () => {
      db.exec(RESPONSES_DDL);
      db.exec(CHAT_COMPLETIONS_DDL);
      db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
    });
    return;
  }
  if (version === 1) {
    runInTransaction(db, () => {
      db.exec(CHAT_COMPLETIONS_DDL);
      db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
    });
    return;
  }
  throw new Error(`unsupported responses database user_version ${version}`);
}

function runInTransaction(db: DatabaseSync, work: () => void): void {
  db.exec("BEGIN");
  try {
    work();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

type ChatStoredRow = {
  id?: string;
  metadata: string;
  body: string;
};

function overlayChatRow(row: ChatStoredRow): Record<string, unknown> {
  const body = JSON.parse(row.body) as Record<string, unknown>;
  return {
    ...body,
    metadata: JSON.parse(row.metadata) as unknown,
  };
}

function serializeMetadata(metadata: Record<string, string> | null): string {
  const value = metadata === null ? {} : metadata;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw paramError("metadata", "Invalid metadata");
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS) {
    throw paramError("metadata", "Invalid metadata");
  }
  for (const key of keys) {
    const item = value[key];
    if (key.length > MAX_METADATA_KEY_CHARS || typeof item !== "string" || item.length > MAX_METADATA_VALUE_CHARS) {
      throw paramError("metadata", "Invalid metadata");
    }
  }
  return JSON.stringify(value);
}

function resolveListLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return LIST_DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > LIST_MAX_LIMIT) {
    throw paramError("limit", "Invalid limit");
  }
  return limit;
}

function resolveListOrder(order: string | undefined): "asc" | "desc" {
  if (order === undefined) {
    return "asc";
  }
  if (order === "asc" || order === "desc") {
    return order;
  }
  throw paramError("order", "Invalid order");
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

function prepareSecretFile(filePath: string): void {
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    throw new Error("CURSOR_RPC_OPENAI_RESPONSES_DB must not be a directory");
  }
  const leaf = dirname(filePath);
  mkdirSync(leaf, { recursive: true, mode: 0o700 });
  chmodSync(leaf, 0o700);
  if (existsSync(filePath)) {
    assertSecretMode(filePath);
  } else {
    const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    closeSync(fd);
    chmodSync(filePath, 0o600);
  }
  assertSecretMode(`${filePath}-wal`);
  assertSecretMode(`${filePath}-shm`);
}

function lockDownSidecars(filePath: string): void {
  for (const side of [`${filePath}-wal`, `${filePath}-shm`]) {
    if (existsSync(side)) {
      chmodSync(side, 0o600);
    }
  }
}

function assertSecretMode(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }
  if ((statSync(filePath).mode & 0o044) !== 0) {
    throw new Error("responses database is group/other-readable");
  }
}

function previousResponseIdError(): HttpError {
  return new HttpError(
    400,
    openaiError({
      message: "Invalid previous_response_id",
      type: "invalid_request_error",
      param: "previous_response_id",
      code: null,
    }),
  );
}
