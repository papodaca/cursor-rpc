import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuthenticationError } from "cursor-rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveResponsesDbPath } from "../src/config.ts";
import { HttpError } from "../src/errors.ts";
import {
  buildListChatCompletionsSql,
  openResponseStore,
  type InsertResponseRow,
  type ResponseStore,
} from "../src/openai/response-store.ts";
import { startServer, type StartedServer } from "../src/server.ts";
import { authHeaders, INBOUND_KEY, startTestServer, tempResponsesDbPath } from "./helpers.ts";

const CURSOR_TOKEN = "key_planted_cursor";
const servers: StartedServer[] = [];
const stores: ResponseStore[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

function respId(): string {
  return `resp_${randomBytes(16).toString("hex")}`;
}

function completedProjection(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: "composer-2",
    output: [],
    error: null,
    incomplete_details: null,
    ...extra,
  };
}

function insertRow(overrides: Partial<InsertResponseRow> & Pick<InsertResponseRow, "id">): InsertResponseRow {
  return {
    status: "completed",
    previousResponseId: null,
    model: "composer-2",
    instructions: "be brief",
    store: true,
    createdAt: 1_700_000_000,
    response: completedProjection(overrides.id),
    transcript: { user: "hello", assistant: "hi" },
    ...overrides,
  };
}

function openStore(path = tempResponsesDbPath()): ResponseStore {
  const store = openResponseStore(path);
  stores.push(store);
  return store;
}

async function startWithDb(
  dbPath: string,
  env: Record<string, string | undefined> = {},
): Promise<StartedServer> {
  const started = await startTestServer(undefined, {
    CURSOR_RPC_OPENAI_RESPONSES_DB: dbPath,
    CURSOR_API_KEY: CURSOR_TOKEN,
    ...env,
  });
  servers.push(started);
  return started;
}

function expectPreviousResponseIdError(run: () => void): void {
  try {
    run();
    expect.fail("expected previous_response_id error");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const http = error as HttpError;
    expect(http.status).toBe(400);
    expect(http.body.error.param).toBe("previous_response_id");
    expect(http.body.error.type).toBe("invalid_request_error");
  }
}

function textColumns(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT * FROM responses").all() as Record<string, unknown>[];
    return JSON.stringify(rows);
  } finally {
    db.close();
  }
}

const V1_RESPONSES_DDL = `CREATE TABLE responses (
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

const CHAT_COMPLETIONS_DDL = `CREATE TABLE chat_completions (
    id TEXT PRIMARY KEY,
    created INTEGER,
    model TEXT,
    metadata TEXT,
    body TEXT
  )`;

function chmodSecret(dbPath: string): void {
  chmodSync(dbPath, 0o600);
  for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(side)) {
      chmodSync(side, 0o600);
    }
  }
}

function withWritableDb(dbPath: string, run: (db: DatabaseSync) => void): void {
  writeFileSync(dbPath, "", { mode: 0o600 });
  chmodSecret(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    run(db);
  } finally {
    db.close();
  }
  chmodSecret(dbPath);
}

function writeV1Fixture(
  dbPath: string,
  options: { responseId?: string; alreadyHasChatTable?: boolean } = {},
): string {
  const id = options.responseId ?? respId();
  const projection = completedProjection(id);
  withWritableDb(dbPath, (db) => {
    db.exec(V1_RESPONSES_DDL);
    if (options.alreadyHasChatTable) {
      db.exec(CHAT_COMPLETIONS_DDL);
    }
    db.exec("PRAGMA user_version = 1");
    db.prepare(
      `INSERT INTO responses (
        id, status, previous_response_id, model, instructions, store, created_at, response_json, transcript_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "completed",
      null,
      "composer-2",
      "be brief",
      1,
      1_700_000_000,
      JSON.stringify(projection),
      JSON.stringify({ user: "hello", assistant: "hi" }),
    );
  });
  return id;
}

function readUserVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  } finally {
    db.close();
  }
}

function listUserTables(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

function chatcmplId(): string {
  return `chatcmpl-${randomBytes(16).toString("hex")}`;
}

function chatBody(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    object: "chat.completion",
    created: 1_700_000_000,
    model: "composer-2",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: "stop",
      },
    ],
    metadata: { stale: "from-body" },
    ...extra,
  };
}

function insertChatRow(
  overrides: Partial<{
    id: string;
    created: number;
    model: string;
    metadata: Record<string, string> | null;
    body: Record<string, unknown>;
  }> = {},
) {
  const id = overrides.id ?? chatcmplId();
  return {
    id,
    created: overrides.created ?? 1_700_000_000,
    model: overrides.model ?? "composer-2",
    metadata: overrides.metadata === undefined ? { team: "alpha" } : overrides.metadata,
    body: overrides.body ?? chatBody(id),
  };
}

function expectParamError(run: () => void, param: string): void {
  try {
    run();
    expect.fail(`expected 400 param ${param}`);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    const http = error as HttpError;
    expect(http.status).toBe(400);
    expect(http.body.error.param).toBe(param);
    expect(http.body.error.type).toBe("invalid_request_error");
  }
}

describe("response store and GET retrieve", () => {
  it("inserts a completed row, survives listener restart, and GET plus chain helper accept that id", async () => {
    const dbPath = tempResponsesDbPath();
    const id = respId();
    const projection = completedProjection(id, { instructions: "be brief" });
    const store = openStore(dbPath);
    store.insert(
      insertRow({
        id,
        response: projection,
        transcript: { user: "hello", assistant: "hi" },
      }),
    );
    expect(() => store.loadAncestorChain(id)).not.toThrow();
    store.close();

    const first = await startWithDb(dbPath);
    const firstGet = await fetch(`${first.url}/v1/responses/${id}`, { headers: authHeaders() });
    expect(firstGet.status).toBe(200);
    expect(firstGet.headers.get("x-request-id")).toMatch(/\S/);
    expect(await firstGet.json()).toEqual(projection);
    await first.close();

    const second = await startWithDb(dbPath);
    const secondGet = await fetch(`${second.url}/v1/responses/${id}`, { headers: authHeaders() });
    expect(secondGet.status).toBe(200);
    expect(await secondGet.json()).toEqual(projection);

    const afterRestart = openStore(dbPath);
    const chain = afterRestart.loadAncestorChain(id);
    expect(chain).toEqual([{ user: "hello", assistant: "hi" }]);
  });

  it("returns 200 object response for a matching Bearer GET of a stored id", async () => {
    const dbPath = tempResponsesDbPath();
    const id = respId();
    const projection = completedProjection(id);
    openStore(dbPath).insert(insertRow({ id, response: projection }));

    const { url } = await startWithDb(dbPath);
    const response = await fetch(`${url}/v1/responses/${id}`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; id: string };
    expect(body.object).toBe("response");
    expect(body.id).toBe(id);
    expect(response.headers.get("x-request-id")).toMatch(/\S/);
  });

  it("uses :memory: or a temp file without touching the default XDG path", () => {
    const canaryHome = join(tmpdir(), `xdg-canary-${randomBytes(8).toString("hex")}`);
    const defaultPath = resolveResponsesDbPath({
      env: { HOME: canaryHome },
    });
    expect(defaultPath).toBe(join(canaryHome, ".local/share/cursor-rpc-openai-server/responses.sqlite"));

    const memory = openStore(":memory:");
    memory.insert(insertRow({ id: respId() }));
    expect(existsSync(dirname(defaultPath))).toBe(false);

    const tempPath = tempResponsesDbPath();
    openStore(tempPath).insert(insertRow({ id: respId() }));
    expect(existsSync(tempPath)).toBe(true);
    expect(existsSync(dirname(defaultPath))).toBe(false);
    expect(tempPath).not.toBe(defaultPath);
  });

  it("commits two overlapping inserts of distinct ids on one connection", async () => {
    const dbPath = tempResponsesDbPath();
    const store = openStore(dbPath);
    const first = insertRow({
      id: respId(),
      transcript: { user: "one", assistant: "ONE" },
      response: completedProjection("pending"),
    });
    first.response = completedProjection(first.id);
    const second = insertRow({
      id: respId(),
      transcript: { user: "two", assistant: "TWO" },
      response: completedProjection("pending"),
    });
    second.response = completedProjection(second.id);
    store.insert(first);
    store.insert(second);

    const { url } = await startWithDb(dbPath);
    const gotFirst = await fetch(`${url}/v1/responses/${first.id}`, { headers: authHeaders() });
    const gotSecond = await fetch(`${url}/v1/responses/${second.id}`, { headers: authHeaders() });
    expect(gotFirst.status).toBe(200);
    expect(gotSecond.status).toBe(200);
    expect((await gotFirst.json()).id).toBe(first.id);
    expect((await gotSecond.json()).id).toBe(second.id);
    expect(store.get(first.id)).toEqual(first.response);
    expect(store.get(second.id)).toEqual(second.response);
    expect(store.loadAncestorChain(first.id)).toEqual([first.transcript]);
    expect(store.loadAncestorChain(second.id)).toEqual([second.transcript]);
  });

  it("creates a new DB file as 0600 and the leaf directory as 0700", () => {
    const leaf = join(tmpdir(), `resp-leaf-${randomBytes(8).toString("hex")}`);
    const dbPath = join(leaf, "responses.sqlite");
    openStore(dbPath);
    expect(statSync(leaf).mode & 0o777).toBe(0o700);
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it("treats a truncated mutation of a real id as missing and does not mint consecutive counters", async () => {
    const dbPath = tempResponsesDbPath();
    const firstId = respId();
    const secondId = respId();
    expect(firstId).not.toBe(secondId);
    const firstNum = Number.parseInt(firstId.slice("resp_".length), 16);
    const secondNum = Number.parseInt(secondId.slice("resp_".length), 16);
    expect(Number.isFinite(firstNum) && Number.isFinite(secondNum)).toBe(true);
    expect(Math.abs(firstNum - secondNum)).not.toBe(1);

    const store = openStore(dbPath);
    store.insert(insertRow({ id: firstId }));
    store.insert(insertRow({ id: secondId }));
    const truncated = firstId.slice(0, -2);
    expect(truncated).not.toBe(firstId);
    expect(store.get(truncated)).toBeUndefined();

    const { url } = await startWithDb(dbPath);
    const response = await fetch(`${url}/v1/responses/${truncated}`, { headers: authHeaders() });
    expect(response.status).toBe(404);
    expect(response.status).not.toBe(400);
  });

  it("returns 404 not 400 for an unknown id and a store:false id", async () => {
    const dbPath = tempResponsesDbPath();
    const unstoredId = respId();
    openStore(dbPath).insert(insertRow({ id: unstoredId, store: false }));

    const { url } = await startWithDb(dbPath);
    const unknown = await fetch(`${url}/v1/responses/${respId()}`, { headers: authHeaders() });
    expect(unknown.status).toBe(404);
    expect(unknown.status).not.toBe(400);
    expect((await unknown.json()).error).toMatchObject({
      type: "invalid_request_error",
    });
    expect(unknown.headers.get("x-request-id")).toMatch(/\S/);

    const unstored = await fetch(`${url}/v1/responses/${unstoredId}`, { headers: authHeaders() });
    expect(unstored.status).toBe(404);
    expect(unstored.status).not.toBe(400);
  });

  it("returns 401 for a wrong Bearer on GET and omits inbound key and planted Cursor token", async () => {
    const dbPath = tempResponsesDbPath();
    const id = respId();
    openStore(dbPath).insert(insertRow({ id }));
    const { url } = await startWithDb(dbPath);
    const response = await fetch(`${url}/v1/responses/${id}`, {
      headers: { Authorization: "Bearer sk-wrong" },
    });
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain(INBOUND_KEY);
    expect(body).not.toContain(CURSOR_TOKEN);
    expect(body).not.toContain("sk-wrong");
    expect(JSON.parse(body).error.code).toBe("invalid_api_key");
  });

  it("returns 401 without Bearer when auth is on", async () => {
    const dbPath = tempResponsesDbPath();
    const id = respId();
    openStore(dbPath).insert(insertRow({ id }));
    const { url } = await startWithDb(dbPath);
    const response = await fetch(`${url}/v1/responses/${id}`);
    expect(response.status).toBe(401);
  });

  it("uses the XDG default path when CURSOR_RPC_OPENAI_RESPONSES_DB is missing", () => {
    const xdg = "/tmp/xdg-data-home-fixture";
    const home = "/tmp/home-fixture";
    expect(
      resolveResponsesDbPath({
        env: { XDG_DATA_HOME: xdg, HOME: home },
      }),
    ).toBe(join(xdg, "cursor-rpc-openai-server/responses.sqlite"));
    expect(isAbsolute(resolveResponsesDbPath({ env: { XDG_DATA_HOME: xdg, HOME: home } }))).toBe(true);

    expect(
      resolveResponsesDbPath({
        env: { HOME: home },
      }),
    ).toBe(join(home, ".local/share/cursor-rpc-openai-server/responses.sqlite"));
  });

  it("resolves a relative DB path from cwd and rejects empty, URI-shaped, and directory paths", async () => {
    const cwd = join(tmpdir(), `resp-cwd-${randomBytes(8).toString("hex")}`);
    mkdirSync(cwd, { recursive: true });
    const resolved = resolveResponsesDbPath({
      env: { CURSOR_RPC_OPENAI_RESPONSES_DB: "rel/responses.sqlite" },
      cwd,
    });
    expect(resolved).toBe(join(cwd, "rel/responses.sqlite"));
    expect(isAbsolute(resolved)).toBe(true);

    expect(() => resolveResponsesDbPath({ env: { CURSOR_RPC_OPENAI_RESPONSES_DB: "" } })).toThrow();
    expect(() => resolveResponsesDbPath({ env: { CURSOR_RPC_OPENAI_RESPONSES_DB: "   " } })).toThrow();
    expect(() => resolveResponsesDbPath({ env: { CURSOR_RPC_OPENAI_RESPONSES_DB: "file:foo.db" } })).toThrow();
    expect(() =>
      resolveResponsesDbPath({ env: { CURSOR_RPC_OPENAI_RESPONSES_DB: "/tmp/foo.db?mode=ro" } }),
    ).toThrow();

    const dir = join(tmpdir(), `resp-dir-${randomBytes(8).toString("hex")}`);
    mkdirSync(dir);
    expect(() => openResponseStore(dir)).toThrow();

    const listen = vi.spyOn(Server.prototype, "listen");
    await expect(
      startServer({
        env: {
          CURSOR_RPC_OPENAI_API_KEY: INBOUND_KEY,
          CURSOR_RPC_OPENAI_HOST: "127.0.0.1",
          CURSOR_RPC_OPENAI_PORT: "0",
          CURSOR_RPC_OPENAI_RESPONSES_DB: "file:./responses.sqlite",
        },
      }),
    ).rejects.toThrow();
    expect(listen).not.toHaveBeenCalled();
  });

  it("refuses to open or listen on a planted 0644 database file", async () => {
    const dbPath = tempResponsesDbPath();
    writeFileSync(dbPath, "", { mode: 0o644 });
    chmodSync(dbPath, 0o644);
    expect(statSync(dbPath).mode & 0o044).not.toBe(0);
    expect(() => openResponseStore(dbPath)).toThrow(/group|other|readable|permission/i);

    const listen = vi.spyOn(Server.prototype, "listen");
    await expect(
      startServer({
        env: {
          CURSOR_RPC_OPENAI_API_KEY: INBOUND_KEY,
          CURSOR_RPC_OPENAI_HOST: "127.0.0.1",
          CURSOR_RPC_OPENAI_PORT: "0",
          CURSOR_RPC_OPENAI_RESPONSES_DB: dbPath,
        },
      }),
    ).rejects.toThrow(/group|other|readable|permission/i);
    expect(listen).not.toHaveBeenCalled();
  });

  it("round-trips hostile quotes and semicolons in id, previous_response_id, and transcript", () => {
    const dbPath = tempResponsesDbPath();
    const store = openStore(dbPath);
    const safe = insertRow({
      id: respId(),
      transcript: { user: "keep me", assistant: "unchanged" },
    });
    store.insert(safe);
    const hostileId = `resp_it's";--drop`;
    const hostilePrev = `prev'";--`;
    store.insert(
      insertRow({
        id: hostileId,
        previousResponseId: hostilePrev,
        transcript: { user: `hi'; DROP TABLE responses;--`, assistant: `ok";--` },
        response: completedProjection(hostileId),
      }),
    );
    expect(store.get(hostileId)).toEqual(completedProjection(hostileId));
    expect(store.get(safe.id)).toEqual(safe.response);
    expect(store.loadAncestorChain(safe.id)).toEqual([safe.transcript]);
    const rows = JSON.parse(textColumns(dbPath)) as Array<{
      id: string;
      previous_response_id: string | null;
      transcript_json: string;
    }>;
    const hostile = rows.find((row) => row.id === hostileId);
    const kept = rows.find((row) => row.id === safe.id);
    expect(hostile?.previous_response_id).toBe(hostilePrev);
    expect(JSON.parse(hostile?.transcript_json ?? "{}")).toEqual({
      user: `hi'; DROP TABLE responses;--`,
      assistant: `ok";--`,
    });
    expect(JSON.parse(kept?.transcript_json ?? "{}")).toEqual(safe.transcript);
  });

  it("rejects a second insert of the same id and leaves the first row unchanged", () => {
    const store = openStore();
    const id = respId();
    const first = insertRow({
      id,
      transcript: { user: "original", assistant: "kept" },
      response: completedProjection(id, { output_text_marker: "first" }),
    });
    store.insert(first);
    expect(() =>
      store.insert(
        insertRow({
          id,
          transcript: { user: "replaced", assistant: "nope" },
          response: completedProjection(id, { output_text_marker: "second" }),
        }),
      ),
    ).toThrow();
    expect(store.get(id)).toEqual(first.response);
    expect(store.loadAncestorChain(id)).toEqual([first.transcript]);
  });

  it("returns 400 from the chain helper for a cycle and a self-parent without hanging", () => {
    const store = openStore();
    const a = respId();
    const b = respId();
    store.insert(insertRow({ id: a, previousResponseId: b, response: completedProjection(a) }));
    store.insert(insertRow({ id: b, previousResponseId: a, response: completedProjection(b) }));
    expectPreviousResponseIdError(() => store.loadAncestorChain(a));
    expectPreviousResponseIdError(() => store.loadAncestorChain(b));

    const self = respId();
    store.insert(insertRow({ id: self, previousResponseId: self, response: completedProjection(self) }));
    expectPreviousResponseIdError(() => store.loadAncestorChain(self));
  });

  it("refuses to open a file with user_version = 3", () => {
    const dbPath = tempResponsesDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA user_version = 3");
    db.close();
    chmodSync(dbPath, 0o600);
    for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(side)) {
        chmodSync(side, 0o600);
      }
    }
    expect(() => openResponseStore(dbPath)).toThrow(/user_version|schema|version/i);
  });

  it("omits AuthenticationError secret material from a stored failed-row projection and keeps the user transcript", async () => {
    const dbPath = tempResponsesDbPath();
    const id = respId();
    const plantedSecret = "sk-auth-error-raw-secret";
    const plantedStack = "STACK_TRACE_PLANTED_at_Object.fake";
    const plantedCause = "CAUSE_SECRET_PLANTED";
    const authError = new AuthenticationError(`invalid Bearer ${plantedSecret}`, {
      cause: { raw: plantedCause, stack: plantedStack },
    });
    authError.stack = plantedStack;
    const projection = {
      id,
      object: "response",
      created_at: 1_700_000_000,
      status: "failed",
      model: "composer-2",
      output: [],
      error: {
        message: "Cursor upstream request failed; this is not caused by the inbound Bearer token",
        type: "api_error",
        param: null,
        code: "cursor_upstream",
      },
    };
    const store = openStore(dbPath);
    store.insert(
      insertRow({
        id,
        status: "failed",
        response: projection,
        transcript: { user: "plaintext prompt log stays", assistant: "" },
      }),
    );
    expect(store.get(id)).toEqual(projection);
    expectPreviousResponseIdError(() => store.loadAncestorChain(id));
    store.close();

    const dumped = textColumns(dbPath);
    expect(dumped).toContain("plaintext prompt log stays");
    expect(dumped).not.toContain(plantedSecret);
    expect(dumped).not.toContain(plantedStack);
    expect(dumped).not.toContain(plantedCause);
    expect(dumped).not.toContain(authError.stack ?? "");
    expect(dumped).not.toMatch(/"cause"/);

    const { url } = await startWithDb(dbPath);
    const response = await fetch(`${url}/v1/responses/${id}`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(plantedSecret);
    expect(body).not.toContain(plantedStack);
    expect(body).not.toContain(plantedCause);
    expect(JSON.parse(body)).toEqual(projection);
  });

  it("opens an empty file as user_version 2 and still inserts plus GETs a response", async () => {
    const dbPath = tempResponsesDbPath();
    const id = respId();
    const projection = completedProjection(id);
    const store = openStore(dbPath);
    store.insert(insertRow({ id, response: projection }));
    store.close();

    expect(readUserVersion(dbPath)).toBe(2);
    expect(listUserTables(dbPath)).toEqual(expect.arrayContaining(["chat_completions", "responses"]));

    const { url } = await startWithDb(dbPath);
    const response = await fetch(`${url}/v1/responses/${id}`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(projection);
  });

  it("migrates a v1 fixture to user_version 2 and GET of the existing resp_ is 200 after restart", async () => {
    const dbPath = tempResponsesDbPath();
    const id = writeV1Fixture(dbPath);
    expect(readUserVersion(dbPath)).toBe(1);
    expect(listUserTables(dbPath)).not.toContain("chat_completions");

    const first = await startWithDb(dbPath);
    const firstGet = await fetch(`${first.url}/v1/responses/${id}`, { headers: authHeaders() });
    expect(firstGet.status).toBe(200);
    expect(await firstGet.json()).toEqual(completedProjection(id));
    await first.close();
    expect(readUserVersion(dbPath)).toBe(2);
    expect(listUserTables(dbPath)).toEqual(expect.arrayContaining(["chat_completions", "responses"]));

    const second = await startWithDb(dbPath);
    const secondGet = await fetch(`${second.url}/v1/responses/${id}`, { headers: authHeaders() });
    expect(secondGet.status).toBe(200);
    expect(await secondGet.json()).toEqual(completedProjection(id));
  });

  it("migrates a v1 file that already has chat_completions, sets user_version 2, and Responses GET still works", async () => {
    const dbPath = tempResponsesDbPath();
    const id = writeV1Fixture(dbPath, { alreadyHasChatTable: true });
    expect(readUserVersion(dbPath)).toBe(1);
    expect(listUserTables(dbPath)).toEqual(expect.arrayContaining(["chat_completions", "responses"]));

    const store = openStore(dbPath);
    expect(store.get(id)).toEqual(completedProjection(id));
    store.close();
    expect(readUserVersion(dbPath)).toBe(2);

    const { url } = await startWithDb(dbPath);
    const response = await fetch(`${url}/v1/responses/${id}`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(completedProjection(id));
  });

  it("commits two overlapping chat inserts of distinct ids", () => {
    const store = openStore();
    const first = insertChatRow({ created: 10, metadata: { n: "1" } });
    const second = insertChatRow({ created: 11, metadata: { n: "2" } });
    store.insertChat(first);
    store.insertChat(second);
    expect(store.getChat(first.id)).toMatchObject({ id: first.id, metadata: { n: "1" } });
    expect(store.getChat(second.id)).toMatchObject({ id: second.id, metadata: { n: "2" } });
  });

  it("round-trips hostile quotes and semicolons in a chat id as bound data", () => {
    const store = openStore();
    const hostileId = `chatcmpl_it's";--drop`;
    const row = insertChatRow({
      id: hostileId,
      metadata: { note: `val'; DROP TABLE chat_completions;--` },
      body: chatBody(hostileId, { choices: [{ index: 0, message: { role: "assistant", content: `ok";--` } }] }),
    });
    store.insertChat(row);
    expect(store.getChat(hostileId)).toMatchObject({
      id: hostileId,
      metadata: { note: `val'; DROP TABLE chat_completions;--` },
    });
    expect(store.getChat(hostileId)?.choices).toEqual([
      { index: 0, message: { role: "assistant", content: `ok";--` } },
    ]);
    expect(store.deleteChat(hostileId)).toBe(true);
    expect(store.getChat(hostileId)).toBeUndefined();
  });

  it("keeps list SQL shape fixed for hostile metadata keys and binds key/value", () => {
    const store = openStore();
    const match = insertChatRow({
      created: 1,
      metadata: { team: "alpha" },
    });
    const other = insertChatRow({
      created: 2,
      metadata: { team: "beta" },
    });
    store.insertChat(match);
    store.insertChat(other);

    const hostileKey = `team'] OR 1=1;--`;
    const hostileValue = `alpha' OR '1'='1`;
    const listSql = buildListChatCompletionsSql({
      metadataFilterCount: 1,
      hasAfter: false,
      hasModel: false,
      order: "asc",
    });
    expect(listSql).toBe(
      buildListChatCompletionsSql({
        metadataFilterCount: 1,
        hasAfter: false,
        hasModel: false,
        order: "asc",
      }),
    );
    expect(listSql).toContain("json_each");
    expect(listSql).not.toMatch(/json_extract/i);
    expect(listSql).not.toContain(hostileKey);
    expect(listSql).not.toContain(hostileValue);
    const injected = store.listChat({ metadata: { [hostileKey]: "alpha" } });
    const boundMiss = store.listChat({ metadata: { team: hostileValue } });
    const boundHit = store.listChat({ metadata: { team: "alpha" } });

    expect(injected).toEqual({
      object: "list",
      data: [],
      first_id: null,
      last_id: null,
      has_more: false,
    });
    expect(boundMiss.data.map((row) => row.id)).toEqual([]);
    expect(boundHit.data.map((row) => row.id)).toEqual([match.id]);
    expect(store.getChat(match.id)).toBeDefined();
    expect(store.getChat(other.id)).toBeDefined();
    expect(store.get(respId())).toBeUndefined();
  });

  it("lists chat rows with default limit 20, bound filters, and metadata overlay from the column", () => {
    const store = openStore();
    expect(store.listChat()).toEqual({
      object: "list",
      data: [],
      first_id: null,
      last_id: null,
      has_more: false,
    });

    const ids: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const id = chatcmplId();
      const row = insertChatRow({
        id,
        created: 100 + i,
        metadata: { team: i % 2 === 0 ? "even" : "odd", i: String(i) },
        body: chatBody(id, { created: 100 + i, metadata: { stale: "body" } }),
      });
      ids.push(row.id);
      store.insertChat(row);
    }

    const firstPage = store.listChat();
    expect(firstPage.data).toHaveLength(20);
    expect(firstPage.first_id).toBe(ids[0]);
    expect(firstPage.last_id).toBe(ids[19]);
    expect(firstPage.has_more).toBe(true);
    expect(firstPage.data[0]?.metadata).toEqual({ team: "even", i: "0" });
    expect(firstPage.data[0]?.id).toBe(ids[0]);

    const after = store.listChat({ after: ids[19] });
    expect(after.data.map((row) => row.id)).toEqual([ids[20]]);
    expect(after.has_more).toBe(false);

    const evens = store.listChat({ metadata: { team: "even" }, limit: 5 });
    expect(evens.data).toHaveLength(5);
    expect(evens.data.every((row) => (row.metadata as { team: string }).team === "even")).toBe(true);
    expect(evens.has_more).toBe(true);

    const desc = store.listChat({ order: "desc", limit: 2 });
    expect(desc.data.map((row) => row.id)).toEqual([ids[20], ids[19]]);
  });

  it("rejects invalid list limit, order, and unknown after", () => {
    const store = openStore();
    const row = insertChatRow();
    store.insertChat(row);
    expectParamError(() => store.listChat({ limit: 0 }), "limit");
    expectParamError(() => store.listChat({ limit: -1 }), "limit");
    expectParamError(() => store.listChat({ limit: 1.5 }), "limit");
    expectParamError(() => store.listChat({ limit: 101 }), "limit");
    expectParamError(() => store.listChat({ limit: "20" as unknown as number }), "limit");
    expectParamError(() => store.listChat({ order: "drop-table" }), "order");
    expectParamError(() => store.listChat({ after: "chatcmpl-missing" }), "after");
  });

  it("updates only the metadata column and overlays it on GET", () => {
    const store = openStore();
    const row = insertChatRow({
      metadata: { team: "alpha" },
      body: chatBody("pending", { choices: [{ index: 0, message: { role: "assistant", content: "keep" } }] }),
    });
    store.insertChat({ ...row, body: { ...row.body, id: row.id } });
    const updated = store.updateChatMetadata(row.id, { team: "beta" });
    expect(updated).toMatchObject({
      id: row.id,
      metadata: { team: "beta" },
      choices: [{ index: 0, message: { role: "assistant", content: "keep" } }],
    });
    expect(store.getChat(row.id)?.metadata).toEqual({ team: "beta" });
    const cleared = store.updateChatMetadata(row.id, null);
    expect(cleared?.metadata).toEqual({});
    expect(store.updateChatMetadata("chatcmpl-missing", { team: "nope" })).toBeUndefined();
    expect(store.deleteChat("chatcmpl-missing")).toBe(false);
  });
});
