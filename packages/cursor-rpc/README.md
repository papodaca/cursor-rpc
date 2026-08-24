# cursor-rpc

`cursor-rpc` is a protocol client for the Cursor agent backend in `docs/specs/rpc_spec.md`. It is not `@cursor/sdk`. It is not a local agent runtime.

## Install

Node.js 22 or later.

```bash
npm install cursor-rpc
```

## Quick start

Pass `apiKey` or set `CURSOR_API_KEY`.

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

Constructor options override `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_API_ENDPOINT`, `CURSOR_API_BASE_URL`, and `CURSOR_WEBSITE_URL`. Pass a raw session token as `authToken`. Pass a `login().wait()` result as `credentials`. Missing credentials throw. The library never opens a browser on its own.

## What you import

`createClient` gives you `models()`, `run()`, and `close()`. `login` returns a pollable authorization URL if you want the browser path. `createWebClient` is the unary client for web fetch and search. `name` is the string `"cursor-rpc"`. `MemoryCredentialStore` is the default in-memory store.

Errors: `CursorRpcError`, `AuthenticationError`, `PolicyError`, `CancelledError`, `TransportUnsupportedError`, `StreamError`.

Protocol types: `AgentClientMessage`, `InteractionQuery`, `ExecServerMessage`, `ConversationHistory`, `ModelDetails`, `AvailableModel`.

## Transport

ConnectRPC over HTTP/2. There is no HTTP/1.1 RunSSE shim and no checkpoint blob resume. Later turns reuse `conversationHistory` from the previous run handle.
