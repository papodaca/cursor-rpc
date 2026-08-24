# cursor-rpc

TypeScript client for Cursor's agent backend. You authenticate, list models, then run one conversation turn as a stream.

This is not `@cursor/sdk`. That package runs a Cursor agent. This one speaks the ConnectRPC protocol the official CLI uses. If you wanted `Agent.create`, you are in the wrong repo.

I reconstructed the wire in [docs/specs/rpc_spec.md](docs/specs/rpc_spec.md) from an unpacked CLI build. No leaked source. Field numbers come from protobuf descriptors. Anything marked unverified in that file still needs a live probe.

## Packages

The root is a private npm workspace and it will refuse to publish. `npm install` at the root puts a symlink at `node_modules/cursor-rpc` pointing at `packages/cursor-rpc`. The other packages import that symlink.

| Package | What it does |
| --- | --- |
| [cursor-rpc](packages/cursor-rpc) | Protocol library. `createClient()`, `login()`, `createWebClient()`. |
| [cursor-rpc-pi](packages/cursor-rpc-pi) | Pi provider plugin. You talk to Pi. Pi talks to Cursor through this. |
| [cursor-rpc-pi-tools](packages/cursor-rpc-pi-tools) | `web_fetch` and `web_search` for Pi, over Cursor's authenticated unaries. |
| [cursor-rpc-opencode](packages/cursor-rpc-opencode) | OpenCode language-model provider. Session and tools stay in OpenCode. |
| [cursor-rpc-openai-server](packages/cursor-rpc-openai-server) | HTTP server that implements OpenAI Chat Completions and Responses. |

Each package README has the flags and the API.

## Quick start

Node.js 22.19 or later if you want every package. The library, the Pi tools, and the OpenCode provider still run on Node 22. `cursor-rpc-pi` and the OpenAI server want 22.19.

You need a Cursor account. `run()` and every completion spend that account's quota.

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

Set `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN`. Or pass `apiKey`, `authToken`, or `credentials`. Constructor options win over the env vars. Missing credentials throw. The library never opens a browser unless you call `login()`, which gives you a pollable authorization URL.

## Develop

```bash
npm install
npm run build
```

Root `npm test` builds the library and checks that the workspaces linked. Package tests are separate.

```bash
npm test -w cursor-rpc
npm test -w cursor-rpc-pi
npm test -w cursor-rpc-pi-tools
npm test -w cursor-rpc-opencode
npm test -w cursor-rpc-openai-server
```

`npm run typecheck` builds `cursor-rpc` first, then typechecks every workspace.

Protobuf-es types are generated from the spec subset in the library package. After you edit that proto:

```bash
npm run generate -w cursor-rpc
```

## Auth and what leaves the machine

In Pi, run `/login cursor-rpc`. In OpenCode, run `opencode auth login` or `/connect` and pick the provider id from your config. The OpenAI server has a second inbound key, `CURSOR_RPC_OPENAI_API_KEY`, so OpenAI SDK clients never see the Cursor token.

Prompts, tool schemas, and tool results go to Cursor. The OpenAI server writes a plaintext SQLite prompt log for this process's Cursor account. Replay by id is why it exists. Binding off loopback or turning inbound auth off is how that log leaks.

Do not paste live keys, JWTs, or poll verifiers into issues.

## License

MIT. Copyright 2026 Ethan Apodaca.
