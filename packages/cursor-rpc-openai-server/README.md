# cursor-rpc-openai-server

OpenAI-compatible HTTP server for Cursor **Chat Completions** and **Responses**. This is not `@cursor/sdk`.

Clients list models, create text chat completions, persist Chat Completions when `store: true` for list/get/update/delete, and create, retrieve, or delete text Responses through `cursor-rpc`. The official SDK uses different methods: `chat.completions.create` versus `responses.create` / `responses.retrieve`. Assistants, embeddings, vision, audio, and tool calling are out of scope. Disable client tool-calling on both protocols; non-empty `tools` or `functions` return 400.

## Start

Requires Node.js 22.19 or later. One process uses one Cursor account.

```bash
export CURSOR_API_KEY=YOUR_CURSOR_API_KEY
export CURSOR_RPC_OPENAI_API_KEY=YOUR_INBOUND_SERVER_KEY
npx cursor-rpc-openai-server
```

`CURSOR_API_KEY` (or `CURSOR_AUTH_TOKEN`) authenticates this process to Cursor. `CURSOR_RPC_OPENAI_API_KEY` is the inbound Bearer that OpenAI SDK clients send. The inbound key is never exchanged for a Cursor token and never appears in responses. Completions and Responses spend this process's Cursor quota.

Default bind is `127.0.0.1:8787`. Point the official SDK at **`http://127.0.0.1:8787/v1`** — use `127.0.0.1`, not `localhost` (IPv6 `::1` misses).

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.CURSOR_RPC_OPENAI_API_KEY,
  baseURL: "http://127.0.0.1:8787/v1",
});

const completion = await openai.chat.completions.create({
  model: "composer-2",
  messages: [{ role: "user", content: "Hello" }],
  store: true,
});

const listed = await openai.chat.completions.list();
const stored = await openai.chat.completions.retrieve(completion.id);
const updated = await openai.chat.completions.update(completion.id, {
  metadata: { team: "ops" },
});
await openai.chat.completions.delete(completion.id);
```

```ts
const response = await openai.responses.create({
  model: "composer-2",
  input: "Hello",
});

const retrieved = await openai.responses.retrieve(response.id);
const replay = await openai.responses.retrieve(response.id, { stream: true });
await openai.responses.delete(response.id);
```

Responses SSE is not Chat Completions chunks. A Responses stream emits typed `event:` frames (`response.created` through `response.completed`) and does not end with `data: [DONE]`. `GET` retrieve `stream=true` replays stored assistant text and is not a new ASK turn; `include` is ignored.

## Auth off (loopback only)

Inbound auth is required by default. Disable it only with exact `CURSOR_RPC_OPENAI_AUTH=off` or `--no-auth`. Auth-off is refused unless the bind host is loopback (`127.0.0.1` or `::1`); auth-off means any loopback client can retrieve by id. Chat list enumerates stored completion bodies to any authenticated caller, including an auth-off loopback client.

```bash
CURSOR_RPC_OPENAI_AUTH=off cursor-rpc-openai-server --host 127.0.0.1 --port 8787
```

## Store

Chat Completions and Responses share one SQLite file so stored `chatcmpl-` and `resp_` ids survive process restart. The file is a **plaintext prompt log for this process's Cursor account**. Create the leaf directory `0700` and the DB file `0600`; the server refuses a group/other-readable existing file.

Set `CURSOR_RPC_OPENAI_RESPONSES_DB` to an absolute filesystem path (relative paths resolve from cwd). If unset, the default is `$XDG_DATA_HOME/cursor-rpc-openai-server/responses.sqlite`, else `~/.local/share/cursor-rpc-openai-server/responses.sqlite`.

Chat persist is opt-in: `store: true` is required for list/get/update/delete. Omitted, `false`, and `null` do not insert. Responses `store` still defaults to omitted-or-true: omit or `true` writes a `resp_` row; `store: false` avoids disk so later GET of that id is 404 and later `previous_response_id` of that id is 400.

Delete is the retention control for both id kinds.

Chat list enumerates every stored completion body (messages included) to any caller who passes the inbound auth gate, including any loopback client when auth is off. Responses remain inspect-by-known-id only. `GET /v1/responses/{id}?stream=true` replays stored assistant text and is not a new ASK turn; `include` is ignored.

Cancel needs background (unsupported): `POST /v1/responses/{id}/cancel` is 400 for stored completed or failed ids and 404 when no committed row exists. Compact is unsupported: `POST /v1/responses/compact` is 400. `input_items` is not implemented.

## Flags and env

| Flag / env | Default | Notes |
| --- | --- | --- |
| `--host` / `CURSOR_RPC_OPENAI_HOST` | `127.0.0.1` | Auth-off requires loopback |
| `--port` / `CURSOR_RPC_OPENAI_PORT` | `8787` | |
| `CURSOR_RPC_OPENAI_API_KEY` | required when auth is on | Inbound Bearer |
| `--no-auth` / `CURSOR_RPC_OPENAI_AUTH=off` | auth on | Does not disable Cursor credentials. Any loopback client can retrieve by id |
| `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | required | Cursor account for `cursor-rpc` |
| `CURSOR_RPC_OPENAI_RESPONSES_DB` | XDG or `~/.local/share/cursor-rpc-openai-server/responses.sqlite` | SQLite path, file mode `0600`. Plaintext prompt log for this process's Cursor account |
