# cursor-rpc-openai-server

OpenAI-compatible HTTP server for Cursor **Chat Completions**. This is not `@cursor/sdk`.

Clients list models and create text completions through `cursor-rpc`. Responses, Assistants, embeddings, vision, audio, and tool calling are out of scope. Disable client tool-calling; non-empty `tools` or `functions` return 400.

## Start

Requires Node.js 22.19 or later. One process uses one Cursor account.

```bash
export CURSOR_API_KEY=YOUR_CURSOR_API_KEY
export CURSOR_RPC_OPENAI_API_KEY=YOUR_INBOUND_SERVER_KEY
npx cursor-rpc-openai-server
```

`CURSOR_API_KEY` (or `CURSOR_AUTH_TOKEN`) authenticates this process to Cursor. `CURSOR_RPC_OPENAI_API_KEY` is the inbound Bearer that OpenAI SDK clients send. The inbound key is never exchanged for a Cursor token and never appears in responses. Completions spend this process's Cursor quota.

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
});
```

## Auth off (loopback only)

Inbound auth is required by default. Disable it only with exact `CURSOR_RPC_OPENAI_AUTH=off` or `--no-auth`. Auth-off is refused unless the bind host is loopback (`127.0.0.1` or `::1`).

```bash
CURSOR_RPC_OPENAI_AUTH=off cursor-rpc-openai-server --host 127.0.0.1 --port 8787
```

## Flags and env

| Flag / env | Default | Notes |
| --- | --- | --- |
| `--host` / `CURSOR_RPC_OPENAI_HOST` | `127.0.0.1` | Auth-off requires loopback |
| `--port` / `CURSOR_RPC_OPENAI_PORT` | `8787` | |
| `CURSOR_RPC_OPENAI_API_KEY` | required when auth is on | Inbound Bearer |
| `--no-auth` / `CURSOR_RPC_OPENAI_AUTH=off` | auth on | Does not disable Cursor credentials |
| `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | required | Cursor account for `cursor-rpc` |
