# cursor-rpc

`cursor-rpc` is a protocol client for the Cursor agent backend documented in `rpc_spec.md`. It is not `@cursor/sdk` and not a local agent runtime.

## Install

Requires Node.js 22 or later.

```bash
npm install cursor-rpc
```

## Quick start

Authenticate with `CURSOR_API_KEY` or pass `apiKey`:

```ts
import { createClient } from "cursor-rpc";

const client = createClient({ apiKey: process.env.CURSOR_API_KEY });
const models = await client.models();
const run = await client.run({ prompt: "Say hello" });
for await (const event of run) {
  if (event.type === "text_delta") {
    process.stdout.write(event.text);
  }
}
const result = await run.wait();
console.log(models.models.length, result.text, result.usage);
```

Constructor options override `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_API_ENDPOINT`, `CURSOR_API_BASE_URL`, and `CURSOR_WEBSITE_URL`. A raw session token can be passed as `authToken`. Missing credentials throw; the library never opens a browser on its own.

## Public exports

- `createClient` — `models()`, `run()`, and `close()` against the protocol backend
- `login` — optional browser-login helper that returns a pollable authorization URL
- `name` — package identity export (`"cursor-rpc"`)
- `MemoryCredentialStore` — default in-memory credential store
- Errors: `CursorRpcError`, `AuthenticationError`, `PolicyError`, `CancelledError`, `TransportUnsupportedError`, `StreamError`
- Protocol types: `AgentClientMessage`, `InteractionQuery`, `ExecServerMessage`, `ConversationHistory`

## Notes

This package speaks ConnectRPC over HTTP/2. It does not implement an HTTP/1.1 RunSSE shim or checkpoint blob resume. Later turns reuse `conversationHistory` from the previous run handle.
