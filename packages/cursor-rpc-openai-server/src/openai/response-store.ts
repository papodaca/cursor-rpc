import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeResponsesDbPath } from "../config.js";
import { HttpError, openaiError } from "../errors.js";

export const SQLITE_BUSY_TIMEOUT_MS = 5000;
const SCHEMA_USER_VERSION = 1;
const MAX_CHAIN_HOPS = 100;

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

export type ResponseStore = {
  readonly path: string;
  insert(row: InsertResponseRow): void;
  get(id: string): Record<string, unknown> | undefined;
  loadAncestorChain(previousResponseId: string): ResponseTranscript[];
  close(): void;
};

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
  const getChainStmt = db.prepare(
    "SELECT status, previous_response_id, transcript_json FROM responses WHERE id = ?",
  );

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
  if (version !== 0) {
    throw new Error(`unsupported responses database user_version ${version}`);
  }
  db.exec(`CREATE TABLE responses (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
    previous_response_id TEXT,
    model TEXT NOT NULL,
    instructions TEXT,
    store INTEGER NOT NULL CHECK (store IN (0, 1)),
    created_at INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    transcript_json TEXT NOT NULL
  )`);
  db.exec(`PRAGMA user_version = ${SCHEMA_USER_VERSION}`);
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
