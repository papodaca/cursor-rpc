---
title: Cursor Protocol Node.js SDK - Plan
type: feat
date: 2026-08-19
origin: rpc_spec.md
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
deepened: 2026-08-19
---

# Cursor Protocol Node.js SDK - Plan

## Goal Capsule

- **Objective:** Ship a TypeScript Node.js library that authenticates to Cursor's ConnectRPC agent backend, lists models, and runs one conversation turn as a typed stream, so agent providers and application code can depend on it without executing local tools.
- **Authority:** `rpc_spec.md` owns wire protocol, headers, auth, bootstrap, model merge, Run stream, and constants. `web_search.md` and `web_fetch.md` own those tools' approval and precheck shapes. `docs/plans/2026-08-19-003-feat-pi-web-tools-plan.md` owns `RunWebFetch` / `RunWebSearch` and a permanent `createWebClient` sibling of `createClient`, not a wrap preview of this plan's client. This plan owns library surface, defaults, and packaging. Repo layout is owned by `docs/plans/2026-08-19-002-feat-npm-workspaces-scaffold-plan.md`. Where they disagree, the named spec owns protocol behavior; this plan owns SDK defaults; the workspaces plan owns repo layout; the web-tools plan owns those unaries and the web-client export.
- **In scope:** Auth (API key, raw token, optional browser-login helper), Connect transport, bootstrap, model catalogue, HTTP/2 `agent.v1.AgentService/Run`, fail-closed exec/interaction/KV replies, portable `conversation_history`, AbortSignal, caller-injected credential store and handlers.
- **Out of scope:** Local shell/file/MCP/computer-use execution, HTTP/1.1 `RunSSE`/`BidiAppend` shim, checkpoint/blob resume, repo indexing, analytics, cloning the official CLI, replacing `@cursor/sdk`.
- **Stop if:** Live probes show the backend is neither Connect JSON nor Connect binary (for example classic gRPC-only). Stop if HTTP/2 bidi cannot be established and the only remaining path is the HTTP/1.1 shim (deferred). Do not invent a third protocol.
- **Execution profile:** Greenfield library. Reconstruct a proto subset from the specs, generate protobuf-es types, then implement transport and run loop with contract tests before a public export freeze.
- **Tail ownership:** Implementer owns packaging, tests, and README disambiguation. Caller of the library owns durable credentials, approval policy, and any local tool implementations.

---

## Product Contract

### Summary

This plan delivers a two-layer TypeScript SDK: a ConnectRPC client plus a small run-a-turn API. Agent providers and application code authenticate, bootstrap, list models, and stream a turn. The library never executes local tools, never prompts, and never hangs waiting for a missing handler.

### Problem Frame

Cursor's agent backend is a ConnectRPC API. Official `@cursor/sdk` runs a local or cloud *agent runtime* (`Agent.create`). It does not expose this backend as a reusable protocol client.

`rpc_spec.md` documents the CLI-style backend: auth REST, unary RPCs, and a bidi `Run` stream with heartbeats, tool exec, interaction queries, and KV blobs. Third-party agent providers need that protocol as a library with programmatic auth and fail-closed replies. Without those defaults, unanswered queries hang the turn with no observed server timeout.

### Requirements

**Identity and packaging**

- R1. The published package is a TypeScript ESM library named `cursor-rpc` that Node 22+ application code can import without a bundler.
- R2. The README's first paragraph states this library is a protocol client for the backend in `rpc_spec.md`, not `@cursor/sdk` and not a local agent runtime.

**Authentication**

- R3. A caller with an API key or a raw auth token can authenticate with no TTY, browser, or OS keychain prompt.
- R4. Browser login is an optional helper that returns a pollable authorization URL and token pair. It is never the default path when credentials are missing.
- R5. Credential persistence is a caller-injected store. The library default is in-memory only.
- R6. Constructor options override `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_API_ENDPOINT`, `CURSOR_API_BASE_URL`, and `CURSOR_WEBSITE_URL` per `rpc_spec.md` §2.2 and §5.
- R7. Detected auth failure clears the store without throwing from the clear itself, then raises a distinct authentication error per `rpc_spec.md` §14.2.

**Transport and headers**

- R8. RPCs use Connect protocol over HTTP/2. Auth REST endpoints stay on plain HTTP JSON, not Connect.
- R9. The client sends JSON codecs first and retries the same RPC with binary protobuf only when the server returns HTTP 415.
- R10. Every Connect RPC carries the interceptor headers in `rpc_spec.md` §4. Ghost mode fails closed to `"true"`. `x-cursor-client-type` and `x-cursor-client-version` are caller-overridable.
- R11. If `GetServerConfig` forces HTTP/1.1, bootstrap still completes and still selects the API origin as the agent host. Opening `run` throws a typed transport-unsupported error naming the reason tag. The library does not hang on bidi over HTTP/1.1.

**Bootstrap and models**

- R12. After auth, bootstrap runs `GetServerConfig` then `GetUserPrivacyMode` before choosing the agent host, then may load `GetMe` lazily, per `rpc_spec.md` §7–§8.
- R13. Model listing issues `GetUsableModels`, `GetDefaultModelForCli`, and `AvailableModels` concurrently and merges them per `rpc_spec.md` §10.4. Only a usable-models failure is fatal.

**Run a turn**

- R14. `run` opens one `agent.v1.AgentService/Run` stream per turn, yields discriminated events, and exposes `wait()` that drains to a structured result.
- R15. Default run posture is `AGENT_MODE_ASK`, `excludeWorkspaceContext: true`, empty advertised tools, and `client_supports_*` unset.
- R16. Every inbound `interaction_query`, `exec_server_message`, and `kv_server_message` receives exactly one terminal reply before the turn continues.
- R17. With no caller handlers: interaction queries are rejected; `web_fetch` allowlist precheck answers `allowlisted: false`; `request_context` returns a minimal env; other execs are declined with `throw`; KV gets report miss errors and KV sets are acked.
- R18. The library sends a 5s client heartbeat and aborts after 30s of inbound silence per `rpc_spec.md` §13.1.
- R19. Multi-turn uses `UserMessageAction.conversation_history`. The library does not implement checkpoint blob resume in this work.
- R20. `AbortSignal` cancels auth poll, run, retry sleep, and in-flight handler calls. Iterator `return()` tears down the RPC and heartbeats.
- R21. Callers can set `x-cursor-agent-allowed-tools` / `x-cursor-agent-exclude-tools` and RequestContext enable flags. Default excludes `web_search_tool_call` and `web_fetch_tool_call` unless the caller opts in.
- R22. Public stream events are a stable discriminated union. Raw protobuf types stay internal or opt-in.

### Key Decisions

- KD1. Protocol SDK, not a local agent. Callers own exec implementations, approval policy, and credential adapters. Governs R3, R5, R16, R17.
- KD2. Public surface is two layers: Connect client and run-a-turn. Governs R8, R14.
- KD3. Fail-closed replies are library-owned. Missing handlers never hang the turn. Governs R16, R17.
- KD4. Portable transcript for multi-turn, not checkpoint plus blob store. Governs R19.
- KD5. Text-generation defaults (ASK, no workspace, web tools excluded) until the caller opts into a wider surface. Governs R15, R21.
- KD6. Complementary to `@cursor/sdk`, not a clone of `Agent.create`. Governs R2.

### Actors

- A1. Agent-provider runtime: API key, no TTY, programmatic handlers or none.
- A2. Application: raw token, no refresh path.
- A3. Developer: optional browser login once, then A2 until JWT expiry.

### Key Flows

- F1. Headless API-key turn
  - **Trigger:** A1 constructs a client with `apiKey` and calls `run`.
  - **Actors:** A1
  - **Steps:** Exchange key; bootstrap; list models; open Run; heartbeat; fail-closed replies; `turn_ended`.
  - **Covered by:** R3, R12, R13, R14, R16, R17, R18
- F2. Raw-token turn then expiry
  - **Trigger:** A2 constructs a client with `authToken` and later receives Unauthenticated.
  - **Actors:** A2
  - **Steps:** Skip exchange; run; on auth failure clear store and throw a distinct error; no silent refresh.
  - **Covered by:** R3, R7
- F3. Optional browser login
  - **Trigger:** A3 calls the login helper.
  - **Actors:** A3
  - **Steps:** Build PKCE-shaped challenge per `rpc_spec.md` §5.1; return URL; poll until tokens or abort.
  - **Covered by:** R4
- F4. Next turn from transcript
  - **Trigger:** A1/A2 pass prior `conversation_history` into a new `run`.
  - **Actors:** A1, A2
  - **Steps:** New Run stream; opening `run_request` carries history; no blob store.
  - **Covered by:** R19
- F5. Forced HTTP/1.1
  - **Trigger:** Server `http2_config` disables bidi HTTP/2.
  - **Actors:** A1
  - **Steps:** Throw transport-unsupported; do not open Run.
  - **Covered by:** R11

### Acceptance Examples

- AE1. Covers R3, R17. Given a client with only an API key and no handlers, when `run` completes an ASK turn, then the process does not hang and any interaction query was rejected.
- AE2. Covers R9. Given a unary that returns HTTP 415 on JSON, when the client retries, then the retry uses Connect binary on the same logical RPC.
- AE3. Covers R16, R17. Given `web_fetch_allowlist_precheck_args` and no exec handler, when the frame arrives, then the reply is `allowlisted: false`, not `throw`.
- AE4. Covers R19. Given turn 1 produced a transcript, when turn 2 sends that history, then the library does not send checkpoint blob IDs.
- AE5. Covers R4. Given no credentials, when the caller constructs the default client, then the library throws authentication-required and does not open a browser.
- AE6. Covers R11. Given `HTTP2_CONFIG_FORCE_ALL_DISABLED`, when bootstrap finishes, then `run` is not attempted.

### Success Criteria

- A1 can list models and complete an ASK turn using only an API key.
- Missing handlers never deadlock a turn in tests.
- JSON and binary codecs are both implemented; JSON support is not advertised until a probe or recorded 415/success path exists.
- README distinguishes this package from `@cursor/sdk`.

### Scope Boundaries

**In this work**

- Reconstruct proto messages required for auth-adjacent unary RPCs, bootstrap, models, and the Run envelopes used in v1.
- Memory credential store plus a store interface.
- Optional browser-login helper as a separate export.

**Deferred for later**

- HTTP/1.1 `RunSSE` + `BidiAppend` shim (`rpc_spec.md` §8.4).
- Checkpoint + KV blob store resume (`rpc_spec.md` §11.8–§13.2).
- Local execution of shell, files, MCP, computer-use.
- Typed convenience policy objects for web search/fetch beyond the generic dispatcher (generic path ships now).
- File and macOS keychain credential adapters.
- Dual CJS publish.
- `NameAgent` and other non-Run AgentService methods.

**Outside this product's identity**

- Official `@cursor/sdk` local/cloud agent runtime.
- Matching official CLI UX, TTY prompts, QR login, or `cli` impersonation as the only identity.
- Analytics, Statsig, repository indexing, background composer.
- Executing tools on the caller's machine as a built-in runtime.

### Sources

- `rpc_spec.md` — backend protocol.
- `web_search.md` — search approval; no exec path.
- `web_fetch.md` — fetch approval plus allowlist precheck exec.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Reconstruct a proto subset from the specs and generate types with `protoc-gen-es` / `@bufbuild/protobuf` v2. Connect-ES `createClient` needs a `DescService`. Hand-rolled JSON without descriptors cannot support the binary 415 fallback. Cite R8, R9, R22.
- KTD2. Use `@connectrpc/connect` 2.x and `@connectrpc/connect-node` `createConnectTransport` with `httpVersion: "2"` for Connect RPCs. Rejected: `@grpc/grpc-js`, `@connectrpc/connect-web` (no Node bidi), hand-rolled §3.3 framing, and splitting `httpVersion` by host in v1. Spec §8 uses HTTP/1.1 on the API host; v1 keeps HTTP/2 for all Connect calls as an R8 divergence. API HTTP/2 connection failure is a transport error, not R11. R11 applies only when `http2_config` forces HTTP/1.1 before Run. Each origin gets its own JSON+binary transport pair and `Http2SessionManager`. Do not share a manager across API host, agent host, and the privacy-probe rewrite origin. Cite R8, R11.
- KTD3. JSON-first is an explicit `useBinaryFormat: false` transport, plus a binary sibling retried only on HTTP 415. connect-node defaults to binary. 415 maps to Connect `unknown`, not `unimplemented`. Remember codec **per origin and per RPC kind** (unary vs bidi). A unary 415 must not flip the bidi codec, and the reverse. Codec fallback finishes before heartbeat or stall timers start and before any event is yielded. `(session-settled: user-approved — chosen over JSON-only or binary-only: live codec is unverified; 415 is the Connect codec signal.)` Conflict call-out: the reference client is binary-first (`rpc_spec.md` §3.4); JSON-first stays because those endpoints are unverified. Cite R9.
- KTD4. Two-layer modules: `transport` has no tool knowledge; `run` owns heartbeats, stall, dispatcher, and transcript. Rejected: putting the R17 dispatcher inside Connect interceptors. Run must not read `CredentialStore`. Token and ghost headers flow Auth REST → store → token provider → interceptor; Run talks only to the bidi stream and dispatcher. `(session-settled: user-approved — chosen over a protocol-only export: agent providers need a turn API, not only RPC stubs.)` Cite R14, KD2.
- KTD5. Inbound dispatcher table is library-owned (per R17). A blanket exec `throw` is wrong for fetch precheck and `request_context`. Cite R16, R17, KD3.
- KTD6. Public errors wrap `ConnectError`. Do not leak Connect types from the stable export. Include `isRetryable`, `code`, `requestId`, and subclasses for auth, policy, cancelled, transport-unsupported, and stream errors. Cite R7, R11.
- KTD7. Stream API is `AsyncIterable` of discriminated events plus `wait()` and `abort()`. No EventEmitter in v1. Cite R14, R20, R22.
- KTD8. Package as ESM-only, `"type": "module"`, `exports`, `engines.node: ">=22"` on `packages/cursor-rpc/package.json`. Create or update that library manifest (ESM exports, errors, vitest, publint/attw). Do not set the repo-root `name` to `cursor-rpc` or remove `private` / `workspaces` from the root. Cite R1.
- KTD9. Replace the stub `createWritableIterable` dependency with a small in-repo async queue. `@connectrpc/connect/protocol` is marked private. Cite R14.
- KTD10. Default `x-cursor-client-type` is `private_worker`, overridable. Do not hard-code `cli`. Cite R10.
- KTD11. Mid-turn stall fails the turn. Abort the stream, stop heartbeats, raise `StreamError` with stall code and `isRetryable: true`. Do not emit reconnecting, do not clear the store, do not reuse a half-closed HTTP/2 stream. Caller retries via F4 on a new Run. `(session-settled: user-approved — chosen over checkpoint/blob resume: third-party clients should send conversation_history.)` Cite R18, R19.
- KTD12. Auth REST uses `fetch` or undici, not the Connect transport. The token provider runs at **call start** (before each unary and before opening Run). Interceptors only attach the already-selected Bearer. Heartbeats must not re-exchange. Do not redeem `refreshToken` (Q1). Do not retry a live Run on `Unauthenticated` from an interceptor. After R7 auth-failure clear, pin that Client instance so constructor or env `apiKey` cannot silent-re-exchange until the caller constructs a new client. Proactive JWT re-exchange remains allowed only while the store still holds `apiKey` and the call has not yet been classified as auth failure. Cite R3, R7, R8.
- KTD13. Public errors, logs, `util.inspect`, probe output, and `error.cause` chains must not include Bearer tokens, API keys, poll verifiers, or proxy userinfo. Network errors that name a proxy strip credentials from the URL per `rpc_spec.md` §5.6 / §14.4. Cite R7.
- KTD14. Constructor and env API/website URLs hard-fail on userinfo and on schemes other than `http`/`https` before any request. This is an SDK default on top of `rpc_spec.md` §2.2 matching (`#` still hard-fails; unmatched https origins are still used as-is). Discard `agent_url_config` unless both URLs are `http`/`https` without userinfo. Cite R6, R12.

### High-Level Technical Design

Component topology:

```mermaid
flowchart TB
  Caller[Caller app or agent provider]
  Client[Public Client]
  Auth[Auth REST]
  Store[CredentialStore]
  Conn[Connect transport]
  Boot[Bootstrap and models]
  Run[Run dispatcher]
  Proto[Generated proto subset]
  Backend[Cursor API and agent hosts]

  Caller --> Client
  Client --> Auth
  Client --> Boot
  Client --> Run
  Auth --> Store
  Auth --> Backend
  Boot --> Conn
  Run --> Conn
  Conn --> Proto
  Conn --> Backend
  Store --> Conn
```

Auth then bootstrap then one Run:

```mermaid
sequenceDiagram
  participant C as Caller
  participant L as Library
  participant A as Auth REST
  participant S as Connect RPCs
  participant R as AgentService Run

  C->>L: createClient apiKey or token
  alt API key
    L->>A: exchange_user_api_key
    A-->>L: accessToken refreshToken
  else raw token
    L->>L: store as access and refresh
  end
  L->>S: GetServerConfig
  L->>S: GetUserPrivacyMode
  L->>L: select agent host
  L->>S: GetUsableModels plus soft RPCs
  C->>L: run prompt plus optional history
  L->>R: run_request
  loop until turn_ended or error
    R-->>L: AgentServerMessage
    L->>C: typed event
    opt query or exec or kv
      L->>R: matching reply
    end
    L->>R: client_heartbeat every 5s
  end
  L-->>C: wait result plus transcript
```

Run lifecycle:

```mermaid
stateDiagram-v2
  [*] --> Connecting
  Connecting --> Streaming: stream open and run_request written
  Connecting --> Failed: connect or auth error
  Streaming --> Streaming: inbound frame resets stall timer
  Streaming --> Ended: turn_ended and clean EOS
  Streaming --> Failed: stall, EOS error, Unauthenticated, abort
  Ended --> [*]
  Failed --> [*]
```

Inbound dispatch (decision points):

```mermaid
flowchart TB
  Frame[Inbound AgentServerMessage]
  Frame --> IU{interaction_update}
  Frame --> IQ{interaction_query}
  Frame --> EX{exec_server_message}
  Frame --> KV{kv_server_message}
  Frame --> CK{checkpoint}
  Frame --> CTL{exec_server_control}
  IU --> Events[Yield typed event]
  IQ --> Reject[Caller handler or rejected]
  EX --> Pre{precheck or request_context or other}
  Pre -->|precheck| False[allowlisted false]
  Pre -->|request_context| Min[minimal RequestContext]
  Pre -->|other| Throw[throw unimplemented]
  KV --> KvReply[get miss error or set ack]
  CK --> Ignore[Ignore for resume. Optional debug event]
  CTL --> AbortExec[Honor abort for in-flight exec]
```

### Output Structure

```text
packages/cursor-rpc/
  proto/                 # reconstructed .proto subset
  src/
    index.ts             # public exports
    errors.ts
    env.ts               # URL and env resolution
    credentials.ts       # CredentialStore
    auth/
    transport/           # Connect + interceptors + codec fallback
    session/             # bootstrap, host selection, models
    run/                 # dispatcher, heartbeats, transcript
    generated/           # protoc-gen-es output
  test/
```

The tree is a scope declaration. Per-unit file lists stay authoritative.

### Implementation Constraints

- Bind `rpc_spec.md` for constants, backoff, header names, and merge rules. Do not re-specify them in units.
- Unknown protobuf JSON fields must be ignored on decode.
- Do not log `Authorization`, tokens, verifiers, or auth.json bodies. Public errors follow KTD13.
- Omit `x-cursor-checksum`. Do not default `x-cursor-client-type` to `cli` (KTD10).
- TLS verification stays on unless an explicit insecure flag is set.
- Pin `@connectrpc/connect`, `@connectrpc/connect-node`, and `@bufbuild/protobuf` as runtime dependencies, not bundled copies.
- Package `exports` must not expose `src/generated`. Optional raw proto, if any, is a separate subpath.

### Sequencing

U1 package scaffold → U2 proto + codegen → U3 transport → U4 auth → U5 bootstrap/models → U6 run dispatcher → U7 public Client and README.

U3 may use a recorded or live unary against `GetServerConfig` to prove codec policy. U6 must not freeze the public event union until U2 message cases exist.

### Sources and Research

External research was load-bearing for KTD2, KTD3, KTD6, KTD8, KTD9, KTD13, KTD14.

- Connect spec: JSON vs `connect+json` envelopes, HTTP 415 for codec, bidi requires HTTP/2 — https://connectrpc.com/docs/protocol/
- connect-node clients: `httpVersion`, binary default, no bidi on HTTP/1.1 — https://connectrpc.com/docs/node/using-clients/
- Connect-ES v2: `createClient`, interceptors, `jsonOptions.ignoreUnknownFields` default true — https://connectrpc.com/docs/web/migrating-to-v2/
- `@cursor/sdk` is a different product (local/cloud runtime) — https://cursor.com/docs/sdk/typescript
- Node 18 EOL; Node 20 EOL 2026-03-24. Floor Node 22.
- Repo is a private npm workspaces wrapper. Spec files stay at `docs/specs/`. The library stub lives at `packages/cursor-rpc`. No `solutions/` learnings.

---

## Implementation Units

### U1. Package scaffold and public errors

- **Goal:** Create or update the ESM TypeScript surface under `packages/cursor-rpc` and a stable error base. Do not replace the private root workspaces manifest in place.
- **Requirements:** R1, KTD6, KTD8, KTD13
- **Dependencies:** None
- **Files:** `packages/cursor-rpc/package.json`, `packages/cursor-rpc/tsconfig.json`, `packages/cursor-rpc/src/index.ts`, `packages/cursor-rpc/src/errors.ts`, `packages/cursor-rpc/test/errors.test.ts`
- **Approach:**
  1. Update `packages/cursor-rpc/package.json` with ESM `exports` (no generated proto), `engines.node: ">=22"`, and scripts for `test`, `typecheck`, and generate. Do not set the repo-root `name` to `cursor-rpc` or remove `private` / `workspaces` from the root.
  2. Keep `packages/cursor-rpc/tsconfig.json` extending `../../tsconfig.base.json`. Do not replace it with a standalone config that duplicates those compiler options.
  3. Add vitest, `@arethetypeswrong/cli` or `publint` as library dev tooling. Connect runtime deps stay on the library package. TypeScript remains the root shared compiler.
  4. Implement wrapped error classes only. No Connect import from `src/index.ts`.
- **Patterns to follow:** Dual-package hazard avoidance: do not bundle `@connectrpc/*`.
- **Test scenarios:**
  - Happy path: `AuthenticationError` is an `Error` subclass with `isRetryable === false`.
  - Edge: `toJSON()` omits token-like fields.
  - Error: constructing `CancelledError` from an abort maps `code` to cancelled.
  - Error: wrapping a cause whose message contains `Bearer` omits that substring from public `message` and `toJSON()`.
- **Verification:** `npm run typecheck -w cursor-rpc` passes on the scaffold. Packed exports resolve as ESM.

### U2. Proto subset and codegen

- **Goal:** Check in reconstructed `.proto` files for v1 RPCs and generate protobuf-es code.
- **Requirements:** R8, R9, R22, KTD1
- **Dependencies:** U1
- **Files:** `packages/cursor-rpc/proto/aiserver/v1/*.proto`, `packages/cursor-rpc/proto/agent/v1/*.proto`, `packages/cursor-rpc/buf.gen.yaml` or equivalent, `packages/cursor-rpc/src/generated/**`, `packages/cursor-rpc/test/proto-json.test.ts`
- **Approach:**
  1. Reconstruct envelopes plus R17 named interaction/exec/KV cases plus `ConversationHistory` plus `exec_server_control`. Do not reconstruct 70+ `ToolCall` payloads; unknown display cases stay opaque (Q3). `AvailableModels` extra fields rely on unknown-field ignore, not a second unit.
  2. Unknown oneof cases must still decode the envelope. Prefer proto3 so unknown fields survive binary.
  3. Generate with `protoc-gen-es` and `import_extension=js`.
  4. Do not check in official Cursor sources. Field numbers and names come from `rpc_spec.md`. Keep U2 as one unit so codec policy and `DescService` share one DoD.
- **Execution note:** Treat golden ProtoJSON fixtures as the first proof, before wiring HTTP.
- **Test scenarios:**
  - Happy path: round-trip JSON for `AgentClientMessage` with `runRequest` and with `clientHeartbeat`.
  - Edge: unknown JSON field on `GetServerConfigResponse` is ignored.
  - Edge: `ttftBreakdown` present alongside `interactionUpdate` decodes both.
  - Error: invalid enum string fails closed in a documented way.
- **Verification:** Generated `DescService` objects exist for `ServerConfigService`, `DashboardService`, `AiService`, and `AgentService`.

### U3. Connect transport, env, interceptors, codec fallback

- **Goal:** Resolve environments and send Connect RPCs with headers, HTTP/2, abort, and JSON→binary on 415.
- **Requirements:** R6, R8, R9, R10, KTD2, KTD3, KTD12, KTD13, KTD14
- **Dependencies:** U1, U2
- **Files:** `packages/cursor-rpc/src/env.ts`, `packages/cursor-rpc/src/transport/connect.ts`, `packages/cursor-rpc/src/transport/headers.ts`, `packages/cursor-rpc/src/transport/codec.ts`, `packages/cursor-rpc/test/env.test.ts`, `packages/cursor-rpc/test/transport.test.ts`
- **Approach:**
  1. Implement URL matching and `#` rejection per `rpc_spec.md` §2.2, plus KTD14 userinfo/scheme hard-fail.
  2. Factory is `origin → { jsonTransport, binaryTransport, sessionManager }`. Enable HTTP/2 pings (10s/20s per spec appendix). Recreate after U5 host selection.
  3. Interceptor stamps §4 headers. Omit `authorization` when no token. Attach access token, never `apiKey`. Fail-closed ghost mode. No checksum.
  4. On HTTP 415 only, retry that RPC kind with the binary transport. Do not treat other 4xx as codec mismatch. Do not copy unary codec memory onto bidi.
  5. Auth REST is not implemented here (U4).
- **Execution note:** Prefer an in-memory Connect `Transport` fake for interceptor tests. Add a live-probe script gated by env, not required for unit green.
- **Test scenarios:**
  - Happy path: env table maps `https://cursor.com` to prod API `https://api2.cursor.sh`.
  - Edge: URL containing `#` throws before any request.
  - Edge: URL with userinfo throws before any request. Non-`http(s)` scheme throws.
  - Error: Covers AE2. Mock 415 on JSON unary then success on binary.
  - Error: HTTP 401 is not retried as binary.
  - Error: streaming 415 retries binary once and does not start heartbeats on the failed attempt.
  - Error: network error that names `https://user:pass@proxy` strips userinfo.
  - Integration: interceptor sets `x-ghost-mode: true` when privacy is unset or the privacy read throws.
  - Integration: empty store omits `Authorization`. Connect uses access token, not apiKey.
  - Integration: JSON and binary transports for two different origins do not share a session manager.
- **Verification:** Unary helper returns a generated message. Abort cancels the call with `CancelledError`.

### U4. Authentication and credential store

- **Goal:** API key exchange, raw token, optional browser-login helper, JWT expiry check, store interface.
- **Requirements:** R3, R4, R5, R6, R7, KTD12, KTD13
- **Dependencies:** U3
- **Files:** `packages/cursor-rpc/src/credentials.ts`, `packages/cursor-rpc/src/auth/token.ts`, `packages/cursor-rpc/src/auth/api-key.ts`, `packages/cursor-rpc/src/auth/login.ts`, `packages/cursor-rpc/test/auth.test.ts`
- **Approach:**
  1. Precedence: explicit token, explicit API key, then env, never implied browser login.
  2. Exchange and poll per `rpc_spec.md` §5. Honour abort and consecutive-failure budget.
  3. `is_expiring_soon` with 300s margin. Refresh is key re-exchange only, and only before a new unary or a new Run open.
  4. `login.ts` is a separate export. Hash the verifier *string* for the challenge.
  5. Prefer Connect `Unauthenticated` for store-clear. Apply spec §14.2 message-substring clearing only to RPCs that sent a Bearer.
  6. After auth-failure clear, pin the Client so the next call on that instance does not re-read constructor `apiKey` (KTD12).
- **Test scenarios:**
  - Happy path: API key exchange persists access, refresh, and apiKey together.
  - Happy path: raw token stored in both slots and never calls exchange.
  - Covers AE5. Missing credentials throws without calling login.
  - Edge: unparseable JWT treated as expiring.
  - Error: `403` with `sign_in_policy_violation` is non-retryable `PolicyError`.
  - Error: poll `404` resets consecutive failures and continues.
  - Error: Covers R7. Unauthenticated clear does not throw from the store.
  - Error: Connect `internal` whose message contains `401` does not clear the store.
  - Error: exchange/poll failures omit API key and poll verifier from public error text.
  - Error: `/auth/poll` is sent with no `Authorization` header.
  - Error: abort during poll issues no further poll GETs.
- **Verification:** Headless tests never open a browser. Login helper unit-tests challenge encoding against a known vector.

### U5. Bootstrap, host selection, and model catalogue

- **Goal:** Critical-path config and privacy, agent host selection, concurrent model merge.
- **Requirements:** R10, R11, R12, R13, KTD10, KTD14
- **Dependencies:** U4
- **Files:** `packages/cursor-rpc/src/session/bootstrap.ts`, `packages/cursor-rpc/src/session/models.ts`, `packages/cursor-rpc/src/session/host.ts`, `packages/cursor-rpc/test/bootstrap.test.ts`, `packages/cursor-rpc/test/models.test.ts`
- **Approach:**
  1. Order and host algorithm per `rpc_spec.md` §7–§8.2. Privacy rewrite of `*.cursor.sh` to `https://api2.cursor.sh` on the privacy RPC only.
  2. If HTTP/1.1 is forced, still select the API origin as agent host. Do not throw during bootstrap. `run` throws `TransportUnsupportedError` with the reason tag (Covers AE6).
  3. Model merge per §10.4. Empty usable list is "no data", not success.
  4. Alias map lowercasing per §10.5. Do not treat local `gpt-5` as usable unless the catalogue contains it.
- **Test scenarios:**
  - Happy path: ghost true selects `agent_url` when both agent URLs parse.
  - Edge: HTTP/1.1 forced selects API origin as agent host and still blocks Run via R11.
  - Edge: `AvailableModels` timeout at 2000ms degrades; usable failure is fatal.
  - Error: both agent URLs invalid discards `agent_url_config`.
  - Error: `file:` or userinfo in either agent URL discards the whole `agent_url_config`.
  - Edge: privacy RPC failure leaves ghost true. `PRIVACY_MODE_NO_TRAINING` is ghost true. Training-allowed is ghost false.
  - Edge: privacy rewrite does not change other RPC bases.
- **Verification:** Bootstrap with fixtures yields a session object containing token getter, ghost mode, agent base URL, and usable models.

### U6. Run dispatcher, heartbeats, and transcript

- **Goal:** One HTTP/2 bidi Run per turn with typed events, fail-closed replies, heartbeats, stall abort, and conversation_history.
- **Requirements:** R14, R15, R16, R17, R18, R19, R20, R21, R22, KTD4, KTD5, KTD7, KTD9, KTD11
- **Dependencies:** U5
- **Files:** `packages/cursor-rpc/src/run/run.ts`, `packages/cursor-rpc/src/run/dispatch.ts`, `packages/cursor-rpc/src/run/events.ts`, `packages/cursor-rpc/src/run/transcript.ts`, `packages/cursor-rpc/src/run/heartbeat.ts`, `packages/cursor-rpc/test/run.test.ts`, `packages/cursor-rpc/test/dispatch.test.ts`, `packages/cursor-rpc/test/transcript.test.ts`
- **Approach:**
  1. Default ASK posture and tool-exclude headers per R15 and R21. Default RequestContext sends empty `workspace_paths` and omits `file_contents` and auto-run, matching the U6 edge test.
  2. Implement dispatcher table in KTD5. Correlation: echo `InteractionQuery.id`; echo exec `id` and `exec_id`. Wrap handler work so exactly one terminal reply is sent even if the handler throws or abort fires. Inbound `exec_server_control` aborts in-flight handler work and still sends exactly one terminal reply when a reply is outstanding.
  3. Heartbeat 5s starts only after a codec-successful stream is wired. Stall 30s. Cleanup on `wait()`, abort, or iterator return. Stall does not reconnect.
  4. Yield discriminated events for text, thinking, notices, tool display, usage, connection state. Drop raw proto from the default union.
  5. Build `conversation_history` from user/assistant/tool-displayable content for the next turn. Ignore checkpoints for resume.
  6. Mid-stream Connect `Unauthenticated` tears down Run, stops heartbeats, follows R7, and does not open a second Run. Partial yielded text stays consumed; `wait()` rejects.
- **Execution note:** Implement dispatcher tests first with a fake bidi iterable so hang prevention is proven before a live Run.
- **Test scenarios:**
  - Happy path: default run sends `x-cursor-agent-exclude-tools` covering `web_search_tool_call` and `web_fetch_tool_call`. Those names are absent from the exclude list only when the caller opts in.
  - Covers AE1. No handlers, injected `interaction_query`, turn still ends.
  - Covers AE3. Fetch precheck without handler replies `allowlisted: false`.
  - Happy path: `text_delta` then `turn_ended` produces `wait()` usage counts.
  - Edge: `is_server_notice` is a distinct event type, not assistant text.
  - Edge: KV get without store returns error result; set acks.
  - Error: inbound `exec_server_control` aborts in-flight handler work and still sends exactly one outstanding reply.
  - Error: unimplemented exec uses `throw` and does not leave the stream unanswered.
  - Error: unknown `interaction_query` case replies `rejected` with the echoed `id`.
  - Error: caller handler throw still sends one R17 reply and does not hang; `wait()` does not fail unless the stream dies.
  - Error: abort during an in-flight handler still sends one reply then tears down the RPC.
  - Error: 30s silence aborts with stall code and `isRetryable: true`; heartbeats stop; store is not cleared.
  - Error: abort during stream tears down RPC and rejects wait.
  - Error: mid-stream Unauthenticated clears store, rejects wait, and does not start another Run.
  - Edge: default RequestContext has empty `workspace_paths` and omits `file_contents`.
  - Integration: Covers AE4. Second `run` serializes history and omits conversationState blobs.
  - Integration: iterator `break` stops heartbeats.
- **Verification:** Fake-transport suite has no hanging tests. Public event types compile without exporting generated proto from `src/index.ts`.

### U7. Public Client facade and README

- **Goal:** One `createClient` entry that wires U3–U6 and documents positioning.
- **Requirements:** R1, R2, R6, R21, KTD12
- **Dependencies:** U6
- **Files:** `packages/cursor-rpc/src/client.ts`, `packages/cursor-rpc/src/index.ts`, `packages/cursor-rpc/README.md`, `packages/cursor-rpc/test/client.test.ts`
- **Approach:**
  1. `createClient({ apiKey, authToken, apiEndpoint, apiBaseUrl, websiteUrl, store, headers, tools, signal })` plus `client.models()`, `client.run()`, and `login` as a named export.
  2. README opens with R2. Include a minimal ASK example using `CURSOR_API_KEY`.
  3. Do not document HTTP/1.1 shim or blob resume as supported.
- **Test scenarios:**
  - Happy path: createClient with apiKey exposes `run` and `models`.
  - Edge: createClient with neither credential nor store token throws before network if env is empty.
  - Error: after Unauthenticated, a second `models()` on the same Client does not call API-key exchange.
  - Test expectation: README example compiles against public types (typecheck of a fixture import).
- **Verification:** `packages/cursor-rpc/src/index.ts` export list is documented. `npm test -w cursor-rpc` and `npm run typecheck -w cursor-rpc` pass.

---

## Verification Contract

| Gate | Command | Applies to | Done signal |
| --- | --- | --- | --- |
| Unit + contract tests | `npm test -w cursor-rpc` | U1–U7 | All tests pass, including dispatcher hang-prevention |
| Types | `npm run typecheck -w cursor-rpc` | U1–U7 | `tsc --noEmit` clean |
| Package shape | `npm exec -w cursor-rpc -- publint` and `npm exec -w cursor-rpc -- attw --pack` after U1/U7 | R1 | ESM exports valid for nodenext |
| Codec probe | optional `npm run probe:codec -w cursor-rpc` when `CURSOR_API_KEY` is set | U3, R9 | Records JSON vs 415 vs binary; JSON support not claimed until recorded |

Do not require a live Cursor account for CI. Live probe is developer-optional.

---

## Definition of Done

**Global**

- Requirements R1–R22 are met or explicitly deferred in Scope Boundaries.
- No abandoned spike code in `packages/cursor-rpc/src/`.
- README matches actual exports and states the `@cursor/sdk` distinction.
- Default client cannot open a browser or block on a prompt.

**Per unit**

- U1: ESM package and errors exist.
- U2: generated services compile.
- U3: 415 fallback tested.
- U4: key, token, and login-helper isolation tested.
- U5: host selection and model merge tested.
- U6: dispatcher, heartbeat, abort, transcript tested.
- U7: public API and README shipped.

---

## System-Wide Impact

Sensitive boundaries: `CredentialStore` (memory default); logs, `toJSON`, `inspect`, `error.cause`, and probe output (KTD13); poll verifier query param; proxy URLs; Connect `Authorization` (access token only) vs auth REST (API key only on exchange, none on poll); server-selected `agent_url`; BYOK fields on `ModelDetails`; `GetMe` email; transcript; default RequestContext.

Library-enforced authn: no authenticated RPC including `models()` without credentials; omit Bearer when the store is empty; never put `apiKey` on Connect RPCs; never send `Authorization` on `/auth/poll`; never imply browser login; never refresh a live Run from an interceptor; after R7 clear, pin the Client (KTD12).

Failure propagation:

| Failure | Library behavior |
| --- | --- |
| Unary or bidi HTTP 415 | Retry that RPC kind with binary (R9, KTD3). No events from the failed attempt. |
| `http2_config` forces HTTP/1.1 | Throw transport-unsupported (R11). No Run. |
| Stall (30s inbound silence) | Fail the turn, `isRetryable: true`, do not clear store (KTD11). |
| Unauthenticated mid-stream | Tear down Run, R7 clear, pin Client, `wait()` rejects, no second Run. |
| EOS Connect error | `StreamError`. No partial-success. |
| Caller handler throw or abort | One R17 reply still sent. Turn continues unless the stream dies. |
| Hung caller handler | Caller-owned. `AbortSignal` remains the timeout (R20). |
| Session manager | Create per origin in U3, replace after U5 host selection, abort on Client close. |

URL and `HTTPS_PROXY` overrides are trusted by the process owner. Embedding apps must not pass untrusted base URLs.

Ghost mode fails closed to `"true"`. Spec §7.2 may present a non-prod token to `https://api2.cursor.sh` on the privacy RPC only.

Agent parity: A1 can do everything A3 can except browser login. Browser login stays human-only.

v1 ships no auto-approve helper. Fail-closed does not stop the backend from fetching a URL if a caller later approves. No local tool execution. No `x-cursor-checksum`. No `cli` impersonation.

Consumers: any Node 22+ process. Not an IDE plugin.

---

## Risks and Dependencies

| Risk | Mitigation |
| --- | --- |
| JSON codec rejected on agent endpoints | KTD3 per-kind binary fallback. Probe before advertising JSON. |
| Sticky codec across unary and bidi | Per-kind memory (KTD3). Streaming 415 test in U3. |
| Session manager shared across API and agent origins | Per-origin managers (KTD2). Recreate after host selection. |
| Constructor `apiKey` survives store clear | Pin Client after R7 (KTD12). U7 test. |
| Server forces HTTP/1.1 | R11 fail fast. Shim is deferred. |
| Hang on unanswered frames | R16–R17 plus U6 tests. |
| Hung caller handlers | AbortSignal (R20). No extra v1 handler timeout. |
| Auth poll duration | Abort during poll (U4). |
| Proto subset misses a required field | Unknown-field ignore; extend proto when probes show gaps. |
| Server rejects `x-cursor-client-type` | Overridable header (KTD10). Probe during U3. |
| Official `@cursor/sdk` confusion | R2 / U7 README. |
| connect-es private `protocol` subpath | KTD9 in-repo queue. |
| No refresh for browser sessions | Document; A1 should use API keys. |
| Secret leak via `cause`, proxy userinfo, or poll verifier | KTD13 plus U1/U3/U4 tests. |
| Caller-supplied base URL forwards Bearer | KTD14. Do not pass untrusted URL overrides. |
| Server `agent_url` forwards the access token | Discard non-http(s) or userinfo configs (KTD14). |
| Spec §14.2 substring false-positive clears the store | Prefer `Unauthenticated`; substring only if Bearer was sent (U4). |
| Privacy RPC pins `*.cursor.sh` to prod API | Keep spec behavior; document residual. |

**Dependencies:** Cursor prod/staging reachability for optional probes. Buf or `protoc-gen-es` on the implementer PATH.

---

## Open Questions

Deferred, not blocking:

- Q1. Does the server redeem `refreshToken` from browser login? Spec `[UNVERIFIED]`. v1 does not call a refresh endpoint.
- Q2. Does an unknown `x-cursor-client-type` get rejected? Overridable; default `private_worker`.
- Q3. Exact remaining `ToolCall` oneof payload types not listed in the spec. v1 treats unknown display cases opaquely.

---

## Documentation and Operational Notes

- README must warn that this talks to Cursor account APIs with the caller's credentials.
- Optional probe script documents required env vars and never prints tokens.
- Changelog should say HTTP/1.1 bidi and blob resume are unsupported.
