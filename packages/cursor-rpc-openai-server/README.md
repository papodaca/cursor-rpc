# cursor-rpc-openai-server

HTTP server that implements OpenAI Chat Completions and Responses, backed by `cursor-rpc`. Not `@cursor/sdk`.

You can list models, create text chat completions, and persist them when `store: true` so list, get, update, and delete work. You can create, retrieve, or delete text Responses. The official SDK uses `chat.completions.create` for one and `responses.create` / `responses.retrieve` for the other. I implemented both because clients pick one and then get angry.

Assistants, embeddings, vision, audio, and tool calling are out. Send a non-empty `tools` or `functions` array and you get 400. Turn tool-calling off on the client.

## Start

Node.js 22.19 or later. One process, one Cursor account.

```bash
export CURSOR_API_KEY=YOUR_CURSOR_API_KEY
export CURSOR_RPC_OPENAI_API_KEY=YOUR_INBOUND_SERVER_KEY
npx cursor-rpc-openai-server
```

`CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` authenticates this process to Cursor. `CURSOR_RPC_OPENAI_API_KEY` is the inbound Bearer that OpenAI SDK clients send. The inbound key is never exchanged for a Cursor token and never appears in responses. Completions and Responses spend this process's Cursor quota.

Default bind is `127.0.0.1:8787`. Point the official SDK at `http://127.0.0.1:8787/v1`. Use `127.0.0.1`, not `localhost`. `localhost` can resolve to IPv6 `::1` and miss the server.

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

Responses SSE is not Chat Completions chunks. A Responses stream emits typed `event:` frames, `response.created` through `response.completed`. It does not end with `data: [DONE]`. `GET` with `stream=true` replays stored assistant text. It is not a new ASK turn. `include` is ignored.

## Auth off, loopback only

Inbound auth is on by default. Turn it off only with the exact value `CURSOR_RPC_OPENAI_AUTH=off` or `--no-auth`. The server refuses auth-off unless the bind host is `127.0.0.1` or `::1`.

Auth-off means any loopback client can retrieve by id. Chat list dumps every stored completion body, messages included, to anyone who passes the inbound gate. That includes an auth-off loopback client. I would not run this on a shared machine with auth off.

```bash
CURSOR_RPC_OPENAI_AUTH=off cursor-rpc-openai-server --host 127.0.0.1 --port 8787
```

## Store

Chat Completions and Responses share one SQLite file so `chatcmpl-` and `resp_` ids survive a restart. The file is a plaintext prompt log for this process's Cursor account. The server creates the leaf directory as `0700` and the DB file as `0600`. It refuses to open an existing file that is group-readable or world-readable.

Set `CURSOR_RPC_OPENAI_RESPONSES_DB` to an absolute filesystem path. Relative paths resolve from cwd. Unset, it uses `$XDG_DATA_HOME/cursor-rpc-openai-server/responses.sqlite`, or `~/.local/share/cursor-rpc-openai-server/responses.sqlite`.

Chat persist is opt-in. You need `store: true` for list, get, update, and delete. Omit it, pass `false`, or pass `null`, and nothing is inserted.

Responses still default the other way. Omit `store` or pass `true` and you get a `resp_` row. `store: false` skips disk. Later GET of that id is 404. Later `previous_response_id` of that id is 400.

Delete is how you drop either kind of id.

Responses stay inspect-by-known-id. There is no list.

`POST /v1/responses/{id}/cancel` needs background runs, which this server does not do. Stored completed or failed ids return 400. A missing row returns 404. `POST /v1/responses/compact` returns 400. `input_items` is not implemented.

## Flags and env

| Flag / env | Default | Notes |
| --- | --- | --- |
| `--host` / `CURSOR_RPC_OPENAI_HOST` | `127.0.0.1` | Auth-off requires loopback |
| `--port` / `CURSOR_RPC_OPENAI_PORT` | `8787` | |
| `CURSOR_RPC_OPENAI_API_KEY` | required when auth is on | Inbound Bearer |
| `--no-auth` / `CURSOR_RPC_OPENAI_AUTH=off` | auth on | Does not disable Cursor credentials. Any loopback client can retrieve by id |
| `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | required | Cursor account for `cursor-rpc` |
| `CURSOR_RPC_OPENAI_RESPONSES_DB` | XDG or `~/.local/share/cursor-rpc-openai-server/responses.sqlite` | SQLite path, file mode `0600`. Plaintext prompt log for this process's Cursor account |
