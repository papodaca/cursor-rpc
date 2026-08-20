# The WebSearch Tool — Clean-Room Implementation Specification

**Target:** an independent client that can (1) authenticate a user, (2) open an authenticated
ConnectRPC transport to the Cursor backend, (3) select a model, (4) run a conversation turn, and
(5) participate correctly in the **`web_search`** tool round trip — approving or denying a search,
and rendering the returned references.

**Method:** derived by black-box reading of an unpacked distribution of the official CLI
(build identifier `2026.08.11-e8db854`). Nothing here is source text. Everything is expressed as
protocol facts, message schemas, decision tables, and pseudocode. Protobuf field names and numbers
come from descriptor metadata, which is public wire-format information.

**Companion documents.** `web_fetch.md` covers the sibling `web_fetch` tool and shares chapters
2–5 verbatim in substance; `spec.md` is the full backend protocol reference. Section pointers of
the form *(spec §N)* and *(fetch §N)* indicate where more detail lives. This document is
self-contained: you can implement a working search client from it alone.

**Status markers:** `[CONFIRMED]` observed directly and unambiguously ·
`[INFERRED]` deduced with high confidence · `[UNVERIFIED]` needs a live probe.

---

## Table of contents

1. [What the tool actually is](#1-what-the-tool-actually-is)
2. [Prerequisite: authentication](#2-prerequisite-authentication)
3. [Prerequisite: transport and headers](#3-prerequisite-transport-and-headers)
4. [Prerequisite: bootstrap and model selection](#4-prerequisite-bootstrap-and-model-selection)
5. [Prerequisite: opening the run stream](#5-prerequisite-opening-the-run-stream)
6. [Message catalogue](#6-message-catalogue)
7. [Lifecycle of one search](#7-lifecycle-of-one-search)
8. [The approval decision](#8-the-approval-decision)
9. [The search-term allowlist](#9-the-search-term-allowlist)
10. [Configuration and persistence](#10-configuration-and-persistence)
11. [Surface-specific policy](#11-surface-specific-policy)
12. [Disabling and gating the tool](#12-disabling-and-gating-the-tool)
13. [Rendering the tool call](#13-rendering-the-tool-call)
14. [The direct RPC: `RunWebSearch`](#14-the-direct-rpc-runwebsearch)
15. [Prompt-side guidance: the year rule](#15-prompt-side-guidance-the-year-rule)
16. [Differences from WebFetch, side by side](#16-differences-from-webfetch-side-by-side)
17. [Errors, rejection reasons, and edge cases](#17-errors-rejection-reasons-and-edge-cases)
18. [Minimum viable web-search client](#18-minimum-viable-web-search-client)
19. [Open questions](#19-open-questions)
20. [Constants quick reference](#20-constants-quick-reference)

---

## 1. What the tool actually is

`web_search` takes a natural-language query, runs a search, and returns a list of ranked
references — each a title, a URL, and an extracted text chunk — to the model.

As with `web_fetch`, the defining architectural fact is:

> **The client never performs the search.** `web_search` is a **server-executed** tool. The backend
> runs the query against its search provider and returns the references. The client's role is
> **policy** — deciding whether the search may run — plus **display**. `[CONFIRMED]`

But the policy surface is meaningfully simpler than the fetch one, in ways that are easy to get
wrong if you generalise from `web_fetch`:

- **There is no allowlist precheck exec.** The exec channel has prechecks for shell, MCP, and web
  fetch. It has none for web search. `[CONFIRMED]`
- **The server cannot pre-authorize a search.** `WebSearchRequestQuery` carries only `args` — there
  is no `skip_approval` field and no smart-mode classifier payload, both of which the fetch query
  has. Every search reaches the client's decision function. `[CONFIRMED]`
- **The primary control is a boolean, not a pattern list.** `autoAcceptWebSearch` in the config
  file is the intended knob. A `WebSearch(term)` allow-entry grammar exists but is honoured on only
  one surface (§9).

So the client's obligations reduce to two:

| Obligation | Channel | Trigger | Reply required |
| --- | --- | --- | --- |
| **Approval** | `interaction_query` / `interaction_response` | `web_search_request_query` | **Yes**, always. |
| **Display** | `interaction_update` | `tool_call_started` / `tool_call_completed` carrying `web_search_tool_call` | No. |

Leaving the approval query unanswered hangs the turn. There is no observed server-side timeout.

---

## 2. Prerequisite: authentication

*(spec §5, §6; identical to fetch §2.)*

Three mutually exclusive credential sources, in precedence order `[CONFIRMED]`:

1. **Raw auth token** — CLI flag or `CURSOR_AUTH_TOKEN`, used verbatim as both access and refresh
   token, with no exchange and no refresh path.
2. **API key** — CLI flag or `CURSOR_API_KEY`, exchanged for a token pair.
3. **Interactive browser login.**

There is no unauthenticated path to model listing or to the agent stream, so none to `web_search`.

### 2.1 Browser login — PKCE-shaped, but not OAuth `[CONFIRMED]`

It resembles OAuth 2.0 PKCE with a device-flow poll and is **not RFC-compliant OAuth**: no
`client_id`, no `/token` endpoint, no `grant_type`, no scopes. The poll returns the token pair
directly as JSON. Do not reach for an OAuth library.

```
verifier  = base64url_nopad(random_bytes(32))
challenge = base64url_nopad(sha256(ascii_bytes_of(verifier)))
uuid      = uuid_v4()
```

`base64url_nopad` is base64 with `+`→`-`, `/`→`_`, padding stripped. The digest is taken over the
**characters of the base64url verifier string**, not the 32 raw bytes — the single most common way
to build a flow that never completes.

Send the user to:

```
{websiteUrl}/loginDeepControl?challenge={challenge}&uuid={uuid}&mode=login&redirectTarget=cli
```

There is no local callback listener; the browser never redirects back. Then poll:

```
GET {apiUrl}/auth/poll?uuid={uuid}&verifier={verifier}
Content-Type: application/json
```

| Parameter | Value |
| --- | --- |
| Maximum attempts | 150 |
| Base delay | 1000 ms |
| Backoff | `min(1000 × 1.2^attempt, 10000)` ms |
| Jitter | none |
| Consecutive-failure budget | 3, then abort |

`404` means "not yet authorized" — reset the failure counter and retry. `403` with
`error == "sign_in_policy_violation"` is a managed-device rejection and is fatal. `2xx` with both
`accessToken` and `refreshToken` is success; ignore any extra members.

### 2.2 API key exchange `[CONFIRMED]`

```
POST {apiUrl}/auth/exchange_user_api_key
Content-Type: application/json
Authorization: Bearer {apiKey}

{}
```

Persist `(accessToken, refreshToken, apiKey)` together — the key is the only credential that
enables silent re-exchange.

### 2.3 Token lifetime `[CONFIRMED]`

The access token is a JWT, evaluated locally with a 300-second margin; an unparseable token counts
as expired. The **only** refresh mechanism is re-running the API-key exchange. The stored
`refreshToken` is never redeemed against any observed endpoint, so a browser-login session cannot
be renewed — drive long-lived automation from an API key.

### 2.4 Credential storage `[CONFIRMED]`

Selected by `AGENT_CLI_CREDENTIAL_STORE`: `memory`, `file`, or unset/`default` (macOS keychain,
file elsewhere). File backend is `~/.{domain}/auth.json` on macOS, `%APPDATA%\{Domain}\auth.json` on
Windows, `${XDG_CONFIG_HOME:-~/.config}/{domain}/auth.json` otherwise, with directory mode `0700`
and file mode `0600` re-applied on every write.

---

## 3. Prerequisite: transport and headers

*(spec §2–§4, §8; identical to fetch §3.)*

| Environment | API URL | Website URL |
| --- | --- | --- |
| `prod` (default) | `https://api2.cursor.sh` | `https://cursor.com` |
| `staging` | `https://staging.cursor.sh` | `https://staging.cursor.sh` |
| `playground` | `https://api.playground.cursor.sh` | `https://playground.cursor.com` |

Overridable by `CURSOR_API_ENDPOINT` / `CURSOR_API_BASE_URL` and `CURSOR_WEBSITE_URL`. Matching an
origin against either column adopts the whole row.

Every RPC is `POST {baseUrl}/{fully.qualified.Service}/{Method}` over ConnectRPC. The reference
client uses binary protobuf with gzip on the agent path; Connect's JSON mode
(`application/json` unary, `application/connect+json` streaming with a 5-byte
flag+big-endian-length envelope) is protocol-equivalent by specification but unobserved against
these endpoints.

Headers stamped on every request `[CONFIRMED]`:

| Header | Value |
| --- | --- |
| `authorization` | `Bearer {accessToken}` |
| `x-ghost-mode` | `"true"` / `"false"`; **fails closed to `"true"`** |
| `x-request-id` | fresh UUID v4 per attempt |
| `x-original-request-id` | UUID v4, stable across retries of one run |
| `x-cursor-client-version` | `cli-{version}` |
| `x-cursor-client-type` | `cli`, `interactive`, `acp`, … |

Plus the two tool-gating headers that matter here — see §12.

HTTP/2 is the default. On HTTP/1.1 the bidi `Run` becomes `RunSSE` downstream plus unary
`BidiService/BidiAppend` upstream, correlated by `x-request-id` and ordered by `append_seqno`.

---

## 4. Prerequisite: bootstrap and model selection

*(spec §7, §10; identical to fetch §4.)*

1. `aiserver.v1.ServerConfigService/GetServerConfig` — transport selection and feature flags.
2. `aiserver.v1.DashboardService/GetUserPrivacyMode` — resolve **before** choosing the agent host,
   because ghost mode selects between two agent hosts.
3. `aiserver.v1.DashboardService/GetMe` — identity. Lazy.
4. Model discovery: `GetUsableModels` (fatal on failure), `GetDefaultModelForCli` (soft), and
   `AvailableModels` (soft, bounded at 2000 ms), issued concurrently and merged.

```proto
message GetUsableModelsRequest  { repeated string custom_model_ids = 1; }
message GetUsableModelsResponse { repeated ModelDetails models = 1; }

message ModelDetails {
  string          model_id           = 1;
  optional ThinkingDetails thinking_details = 2;
  string          display_model_id   = 3;
  string          display_name       = 4;
  string          display_name_short = 5;
  repeated string aliases            = 6;
  optional bool   max_mode           = 7;
  oneof credentials { ApiKeyCredentials  api_key_credentials  = 8;
                      AzureCredentials   azure_credentials    = 9;
                      BedrockCredentials bedrock_credentials  = 10; }
}
```

An empty `models` list means "no data", not "no models"; models are presented in the returned order
with no sorting. Any model reporting `supports_agent` suffices — no capability flag gates web
search, because the tool runs server-side.

One search-specific wrinkle: the **direct** search RPC (§14) takes a `model_id` in its request,
unlike the direct fetch RPC. If you use that endpoint rather than the agent stream, you must pass a
model identifier from this catalogue.

---

## 5. Prerequisite: opening the run stream

*(spec §11; identical to fetch §5.)*

```proto
message AgentClientMessage {
  oneof message {
    AgentRunRequest          run_request                 = 1;
    ExecClientMessage        exec_client_message         = 2;
    KvClientMessage          kv_client_message           = 3;
    ConversationAction       conversation_action         = 4;
    ExecClientControlMessage exec_client_control_message = 5;
    InteractionResponse      interaction_response        = 6;
    ClientHeartbeat          client_heartbeat            = 7;
    PrewarmRequest           prewarm_request             = 8;
  }
}

message AgentServerMessage {
  oneof message {
    InteractionUpdate          interaction_update             = 1;
    ExecServerMessage          exec_server_message            = 2;
    ConversationStateStructure conversation_checkpoint_update = 3;
    KvServerMessage            kv_server_message              = 4;
    ExecServerControlMessage   exec_server_control_message    = 5;
    InteractionQuery           interaction_query              = 7;
  }
  TtftBreakdown ttft_breakdown = 8;   // NOT inside the oneof
}
```

The first client message must be exactly one `run_request` carrying `conversation_state` (empty for
a new conversation), `action`, `model_details`, and a generated `conversation_id`.

`ttft_breakdown` sits outside the oneof and may accompany any frame. There is **no error case** in
`AgentServerMessage`; failures arrive as ConnectRPC stream errors.

Liveness: a **fixed 5000 ms** heartbeat from the moment the stream is wired, and a **30 000 ms**
no-inbound-frame stall detector that aborts into the retry path.

For web search, exactly one message type on this stream requires a reply: an `interaction_query`
carrying `web_search_request_query`.

---

## 6. Message catalogue

### 6.1 Core tool types — package `agent.v1` `[CONFIRMED]`

```proto
message WebSearchArgs {
  string search_term  = 1;
  string tool_call_id = 2;    // matches ToolCall.tool_call_id (field 57), not call_id
}

message WebSearchResult {
  oneof result {
    WebSearchSuccess  success  = 1;
    WebSearchError    error    = 2;
    WebSearchRejected rejected = 3;
  }
}

message WebSearchSuccess  { repeated WebSearchReference references = 1; }
message WebSearchError    { string error  = 1; }     // note: no url field, unlike WebFetchError
message WebSearchRejected { string reason = 1; }

message WebSearchReference {
  string title = 1;
  string url   = 2;
  string chunk = 3;    // extracted text excerpt
}

message WebSearchToolCall {
  WebSearchArgs   args   = 1;
  WebSearchResult result = 2;
}
```

`WebSearchSuccess` carries **no answer string** — only references. Any synthesis is the model's job.
Contrast the direct RPC in §14, which does return an optional `answer`.

### 6.2 Approval types — package `agent.v1` `[CONFIRMED]`

```proto
message WebSearchRequestQuery {
  WebSearchArgs args = 1;
}

message WebSearchRequestResponse {
  oneof result {
    Approved approved = 1;   // empty message
    Rejected rejected = 2;   // { string reason = 1; }
  }
}
```

**This is the shortest approval query in the protocol.** No `skip_approval` (field 2 on the fetch
equivalent), no `smart_mode_approval` (field 3 there). The consequences are structural: the server
has no way to tell the client "I have already cleared this", and the Auto-review classifier has no
channel through which to pre-approve a search. Every single search invocation round-trips to the
client's decision function.

### 6.3 Field numbers on the shared envelopes `[CONFIRMED]`

| Envelope | Field | # |
| --- | --- | --- |
| `InteractionQuery.query` | `web_search_request_query` | 2 |
| `InteractionResponse.result` | `web_search_request_response` | 2 |
| `ToolCall.tool` | `web_search_tool_call` | 18 |
| exec channel | — | **none; there is no web-search exec** |

`InteractionQuery.id` and `InteractionResponse.id` are `uint32` and must match. Query and response
field numbers are parallel by design across all interaction types — web search is number 2 on both
sides, the lowest-numbered and therefore oldest interaction type in the protocol. `[INFERRED]`

### 6.4 The three correlation ids

Unchanged from the fetch path, and still not interchangeable. `[CONFIRMED]`

| Id | Scope |
| --- | --- |
| `call_id` | Transport-level; spans `partial_tool_call` → `started` → `completed`. |
| `model_call_id` | The id the underlying LLM assigned. |
| `ToolCall.tool_call_id` (field 57) | Durable id in history; this is what `WebSearchArgs.tool_call_id` carries. |

### 6.5 The IDE-facing tool surface — package `aiserver.v1` `[CONFIRMED]`

A parallel set of types exists for the editor's streaming tool protocol. They are **different
messages with the same names** as the `agent.v1` ones; qualify fully in generated code.

```proto
message WebSearchParams { string search_term = 1; }
message WebSearchStream { string search_term = 1; }

message WebSearchResult {                                  // aiserver.v1 flavour
  repeated WebReference references = 1;
  optional bool is_final           = 2;                    // streaming: more may follow
  optional bool rejected           = 3;
}
message WebSearchResult.WebReference { string title = 1; string url = 2; string chunk = 3; }
```

Wired into the editor's tool oneofs as `web_search_params` 26, `web_search_result` 27, and
`web_search_stream` 28, with an enum entry `CLIENT_SIDE_TOOL_V2_WEB_SEARCH = 18`.

That enum entry is worth noting for what it implies about history: web search has a slot in the
**client-side** tool enumeration and a streaming result shape with an `is_final` flag, which web
fetch does not. `[CONFIRMED]` for the schema, `[UNVERIFIED]` for whether any current surface
executes search client-side.

---

## 7. Lifecycle of one search

1. **Streaming arguments (optional).** Zero or more `interaction_update.partial_tool_call` frames
   carry `args_text_delta` as the model composes the query. Display only.
2. **Approval.** An `interaction_query` carrying `web_search_request_query` arrives. Reply with an
   `interaction_response` carrying `web_search_request_response`, echoing `id`. See §8. There is no
   precheck step and no `skip_approval` shortcut.
3. **Execution.** On approval the backend runs the search. The client does nothing.
4. **Start notification.** `interaction_update.tool_call_started` with a `ToolCall` whose case is
   `web_search_tool_call`; `args.search_term` populated, `result` empty.
5. **Completion.** `interaction_update.tool_call_completed` with the same `call_id`, carrying
   `success` (a reference list), `error` (a message), or `rejected` (the reason the client sent).
6. The turn continues to `turn_ended`.

On rejection the server still narrates the call: expect a `tool_call_completed` whose result case is
`rejected`, echoing your reason string. That is not an error condition.

Like the fetch prompt, the search prompt carries **no deadline** — it waits indefinitely for a
human. Non-interactive surfaces must therefore decide synchronously.

---

## 8. The approval decision

### 8.1 The decision function `[CONFIRMED]`

```
function decide_web_search(options):
    # 0. Hard environment kill switch — checked FIRST, and inside the shared policy.
    if eval_hardening_active():                       # §12.2
        return REJECTED("Web search is disabled in this environment")

    # 1. Explicit force, Run Everything mode, or the standing auto-accept setting.
    if options.force_approve or options.is_run_everything or config.autoAcceptWebSearch:
        return APPROVED

    # 2. Ask, if this surface can ask.
    if options.allow_prompt:
        return prompt_user(query.args.search_term)    # §8.3

    # 3. Otherwise decline.
    return REJECTED("User Rejected")
```

Three differences from the fetch ladder are load-bearing, and all three are behaviour rather than
implementation freedom:

- **The kill switch is inside this function.** For web fetch the equivalent check lives only in the
  non-interactive fallback helper, so an interactive session still prompts under the kill switch.
  For web search, *every* surface refuses. `[CONFIRMED]`
- **There is no allowlist consultation here.** The shared policy never looks at
  `permissions.allow`. `WebSearch(term)` entries are matched on exactly one surface, and it is not
  this one (§9).
- **`autoAcceptWebSearch` short-circuits the prompt entirely**, and it is a plain boolean with no
  per-query granularity.

If the prompt branch is chosen but the surface provides no prompt callback, the result is
`REJECTED("User Rejected")`.

### 8.2 What `is_run_everything` means `[CONFIRMED]`

Identical to the fetch path. The user's `approvalMode` is resolved against team administrator
controls before it takes effect:

```
function resolve_approval_mode(setting, team_controls, sandbox_available):
    switch setting:
        case "allowlist":    return "allowlist"
        case "unrestricted":
            allowed = not (team_controls.enabled == true and team_controls.enableRunEverything != true)
            return allowed ? "unrestricted" : "allowlist"
        case "auto-review":
            allowed = not (team_controls.enabled == true and team_controls.enableSmartAuto != true)
            return (allowed and classifier_model_available) ? "auto-review" : "allowlist"

is_run_everything = (resolved == "unrestricted")
```

The team-controls lookup is memoised per provider and **fails open**. `--force` and `--yolo` select
`unrestricted`; `--auto-review` selects `auto-review` and is rejected in combination with `--force`.

Note that `auto-review` does **not** help a search: with no `smart_mode_approval` field on the
query, the classifier cannot express an opinion about it, so an Auto-review session falls back to
prompting exactly as `allowlist` would. `[INFERRED]`

### 8.3 The interactive prompt `[CONFIRMED]`

| Element | Value |
| --- | --- |
| Question | `Allow this web search?` |
| Primary detail | the search term |
| Option 1 | `Allow search` — hint `(y)`, action *approve* |
| Option 2 | `Run Everything` or `Run in Sandbox` — hint `(shift+tab)`, action *autorun-approve*; present only when the mode is available |
| Option 3 | `Skip` — hint `(esc or n)`, action *reject* |
| Default on dismissal | *reject* |

Two contrasts with the fetch prompt, both visible to users:

- The search prompt **offers the autorun escalation** (switch the whole session to Run Everything
  or Sandbox mode). The fetch prompt does not.
- The search prompt offers **no "always allow"** affordance, and the allowlist-entry extractor
  returns an empty list for search operations. In the terminal UI there is therefore no path from a
  prompt to a persisted `WebSearch(...)` entry. `[CONFIRMED]`

Analytics bracket the prompt: a request event with `tool = "web-search"` and `type = "approval"`,
then a response event carrying the outcome.

### 8.4 Building the response

```
approved:  InteractionResponse { id: query.id,
             web_search_request_response: { approved: {} } }

rejected:  InteractionResponse { id: query.id,
             web_search_request_response: { rejected: { reason: <string> } } }
```

The reason is surfaced to the model and echoed into `WebSearchResult.rejected.reason`, so make it
actionable. `"User Rejected"` is the generic default.

---

## 9. The search-term allowlist

A `WebSearch(...)` entry grammar exists in the permission list, parallel to `WebFetch(...)`,
`Shell(...)`, `Mcp(...)`, and `Write(...)`. Its semantics are **exact string equality**, not
pattern matching:

```
function matches_web_search_entry(entry, search_term):
    m = regex_match(entry, /^\s*WebSearch\s*\(([\s\S]*)\)\s*$/)
    if not m: return false
    return trim(m.group(1)) == trim(search_term)      # exact, case-sensitive
```

Points an implementer will trip over:

- **Exact equality, case-sensitive.** `WebSearch(rust async)` authorises the literal query
  `rust async` and nothing else — not `Rust async`, not `rust async runtime`. There is no
  wildcard, no prefix match, no normalisation beyond trimming. Compare the fetch matcher, which
  implements four pattern forms over hostnames (fetch §10).
- **The inner capture spans newlines.** The fetch grammar uses a dot-star that stops at a newline;
  the search grammar uses an explicit any-character class, so a multi-line query can be encoded in
  an entry. `[CONFIRMED]`
- **Only one surface honours it.** The editor-integration (ACP) path checks it. The shared approval
  policy — used by the interactive terminal UI, headless mode, subagents, and side questions —
  never does. `[CONFIRMED]`
- **Only one surface writes it.** The ACP "allow always" option persists
  `WebSearch({search_term})`. Nothing in the terminal UI creates such an entry; a terminal user must
  hand-edit the config (the settings pager exposes `permissions.allow` as a raw JSON array).

The practical consequence: for a terminal-style client, treat `autoAcceptWebSearch` as the control
and the entry grammar as an ACP-only feature you may implement for compatibility. For an
editor-style client, implement both.

---

## 10. Configuration and persistence

### 10.1 Where it lives `[CONFIRMED]`

Config file: `{configDir}/cli-config.json`, where `configDir` is `CURSOR_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/cursor`, else `~/.cursor`.

| Key | Type | Default | Meaning for search |
| --- | --- | --- | --- |
| `autoAcceptWebSearch` | bool | `false` | Approve every search without prompting. The primary control. |
| `approvalMode` | `"allowlist"` \| `"unrestricted"` \| `"auto-review"` | `"allowlist"` | `unrestricted` approves everything (§8.2). |
| `permissions.allow` | string[] | `[]` | May contain `WebSearch(term)` entries; honoured in ACP only (§9). |
| `permissions.deny` | string[] | `[]` | **Never consulted for web search on any observed path.** |

The settings pager exposes `autoAcceptWebSearch` as a boolean toggle labelled
*Auto-Accept Web Search* — "Allow the agent to run web searches without approval prompts" — in the
Permissions group, alongside a raw-JSON editor for `permissions.allow`.

There is no search analogue of `webFetchDomainAllowlist`, the migration array that seeds fetch
host entries.

### 10.2 Persisting an "always allow" (ACP only) `[CONFIRMED]`

```
function allowlist_entry(permissions_provider, kind, value):
    entry = kind + "(" + value + ")"                 # e.g. WebSearch(rust async runtime)
    update permissions atomically:
        allow = allow already contains entry ? allow : allow + [entry]
```

Dedupe is exact string comparison. Because matching trims but storage does not normalise, cosmetic
duplicates are possible and harmless.

---

## 11. Surface-specific policy

`[CONFIRMED]`

| Surface | Prompting | Behaviour when not auto-accepted |
| --- | --- | --- |
| Interactive TUI | yes | Prompts (§8.3). No "always allow"; the escalation on offer is session-wide autorun. |
| Headless (`--print`) | no | Approved if the force/Run-Everything flag is set **or** `autoAcceptWebSearch` is true. Otherwise `REJECTED("User Rejected")`. |
| ACP (editor integration) | yes, via the ACP permission RPC | Checks, in order: kill switch → Run Everything → `autoAcceptWebSearch` → `WebSearch(term)` allow entries → prompt. Options `allow-once` / `allow-always` / `reject-once`; `allow-always` persists the entry. Cancellation ⇒ `REJECTED("Cancelled")`. |
| ACP subagent host | yes | Prompt titled `Allow web search?` with description `Search query: {term}`, tool-call id `subagent-web-search-{queryId}`. **No allow-always option** — unlike the subagent fetch prompt, which offers one. |
| CLI subagent host adapter | no | `REJECTED("Web search requires host approval")` unless the host supplies a handler. |
| Side question | no | `REJECTED("Side question cannot search the web")`. |

The shared non-interactive fallback helper, used by headless, subagents, and side questions:

```
if not eval_hardening_active() and options.approve_web_search:
    approve()
else:
    reject(eval_hardening_active() ? "Web search is disabled in this environment"
                                   : options.web_search_reject_reason ?? "User Rejected")
```

Note the shape difference from the fetch branch of the same helper: fetch has an extra
`skip_approval` escape hatch in this expression, search does not, because the field does not exist.

---

## 12. Disabling and gating the tool

### 12.1 Excluding the tool from the session `[CONFIRMED]`

Two request headers gate which tools the server may offer. Values are comma-joined **`ToolCall`
oneof field names**:

| Header | Meaning |
| --- | --- |
| `x-cursor-agent-allowed-tools` | Allow only these tools. |
| `x-cursor-agent-exclude-tools` | Exclude these tools. |

The name for this tool is `web_search_tool_call`. Names are validated client-side against the live
`ToolCall` oneof field list, and an unknown name is a startup error — so the value is the proto
field name, not `web_search` and not `WebSearch`.

This is the right way to build a client that must never search: exclude the tool so the model is
never offered it, rather than rejecting queries after the fact.

### 12.2 The environment kill switch `[CONFIRMED]`

```
function eval_hardening_active():
    forced = truthy(env["CURSOR_FORCED_SHELL_EGRESS"])
    if not forced: return false
    return not truthy(env["CURSOR_FORCED_SHELL_EGRESS_ALLOW_WEB_TOOLS"])

function truthy(v):
    s = lowercase(trim(v ?? ""))
    return s != "" and s != "0" and s != "false" and s != "off"
```

Both values are memoised on first read. When active, **all** surfaces reject a search with
`"Web search is disabled in this environment"`, because the check sits at the top of the shared
policy rather than only in the non-interactive helper. This is the one place where search is more
strictly controlled than fetch.

### 12.3 Hooks `[UNVERIFIED]`

The hook subsystem maps the Claude-style tool name `WebSearch` onto its own `WebSearch` matcher for
`preToolUse` / `postToolUse` events. Every observed enforcement site, however, is on a
**client-executed** tool path (shell, MCP, file read). Whether a hook can block a server-executed
search is not determinable from the distribution. Use §12.1 for a hard control.

---

## 13. Rendering the tool call

`[CONFIRMED]`

| Field | Value |
| --- | --- |
| Tool label | `WebSearch` |
| Primary line | the search term |
| Status | `pending` when `result` is unset, else `success` / `error` / `rejected` |
| Success detail | `Found {n} reference{s}` where `n` is the length of `references` |
| Error line | `Error: {WebSearchError.error}`, defaulting to `Unknown error` |
| Rejected note | `WebSearchRejected.reason`, defaulting to `Web search rejected` |

The reference count is pluralised, and a zero-reference success still renders as a success. Compact
renderings elsewhere: `Searching web` / `Searched web` with a truncated term in the condensed
transcript, `Web search {term}` in message summaries, and `Web Search: "{term}"` with an ACP tool
kind of `search` in the editor integration.

A missing `args` renders nothing at all — the renderer bails before drawing a header.

Rendering the references themselves is left to the client; the protocol supplies title, URL, and
chunk per reference and no ordering guarantee beyond list order. `[INFERRED]`

---

## 14. The direct RPC: `RunWebSearch`

Separately from the agent stream, the backend exposes a unary search endpoint on
`aiserver.v1.AiService`. `[CONFIRMED]` as a declared method; `[UNVERIFIED]` in behaviour, because
the reference CLI declares it and never calls it.

```
POST {apiUrl}/aiserver.v1.AiService/RunWebSearch
```

```proto
message RunWebSearchRequest {
  string search_term        = 1;
  optional string explanation = 2;   // free-text rationale, purpose unobserved
  string model_id           = 3;     // from the model catalogue, §4
}

message RunWebSearchResponse {
  optional string answer              = 1;   // synthesised answer, absent in the streamed tool
  repeated WebSearchDocument documents = 2;
}

message WebSearchDocument { string url = 1; string title = 2; string text = 3; }
```

Three shape differences from the agent-stream result are worth internalising before you write a
mapping layer:

- The direct RPC returns an optional **`answer`** string. The in-conversation
  `WebSearchSuccess` has no such field — only references.
- Documents are `{url, title, text}`; references are `{title, url, chunk}`. Same three concepts,
  different field names **and** different field numbers.
- The request carries a **`model_id`**, implying server-side synthesis is model-parameterised. The
  direct fetch RPC takes no model.

---

## 15. Prompt-side guidance: the year rule

The distribution exports a helper that builds a block of instruction text about date handling in
search queries, given today's date as an ISO `YYYY-MM-DD` string. `[CONFIRMED]` that it exists and
is exported; `[UNVERIFIED]` where it is consumed — no caller appears inside the bundle, so it is
most likely injected into the tool description by the server or by an SDK consumer.

Its behaviour, since it is a pure function worth reproducing for prompt parity:

```
function build_year_guidance(iso_date):
    require length(iso_date) == 10 and iso_date[4] == "-" and iso_date[7] == "-"
    year      = iso_date[0:4]
    prior     = is_numeric(year) ? string(int(year) - 1) : year
    return a paragraph that:
      - states today's date,
      - instructs the model to use THIS year when searching for recent information,
        documentation, or current events,
      - and gives a worked example contrasting a query containing {year}
        with the same query containing {prior}, marking the latter as wrong.
```

The validation is strict positional checking, not date parsing: a malformed input throws rather
than degrading. Implementers who surface a search tool to a model should carry equivalent guidance;
without it, models reliably search for last year's documentation.

---

## 16. Differences from WebFetch, side by side

Both tools are server-executed and share the interaction-query mechanism, which makes it tempting
to implement one and alias the other. These are the places where that breaks. `[CONFIRMED]`

| Dimension | `web_search` | `web_fetch` |
| --- | --- | --- |
| Input | `search_term` (free text) | `url` |
| Output | `references[] {title, url, chunk}` | `markdown` string |
| `InteractionQuery` field | 2 | 9 |
| `ToolCall` field | 18 | 37 |
| Query has `skip_approval` | **no** | yes (field 2) |
| Query has `smart_mode_approval` | **no** | yes (field 3) |
| Allowlist precheck exec | **none** | yes (exec field 43) |
| Allowlist grammar | `WebSearch(exact term)` | `WebFetch(host pattern)` with wildcard/suffix/CIDR forms |
| Allowlist honoured by | ACP only | all surfaces (allow list); deny list in the precheck |
| Standing auto-approve setting | `autoAcceptWebSearch` | none |
| Prompt offers "always allow" | no (except ACP) | yes, `Always allow {host}` |
| Prompt offers autorun escalation | yes | no |
| Kill switch reaches interactive UI | **yes** | no |
| Error message carries the input | no (`{error}`) | yes (`{url, error}`) |
| Direct RPC request | `{search_term, explanation?, model_id}` | `{url}` |
| Direct RPC response | `{answer?, documents[]}` | `{content}` or `{error, is_timeout}` |
| IDE tool enum entry | `CLIENT_SIDE_TOOL_V2_WEB_SEARCH = 18` | none |
| Exclusion header value | `web_search_tool_call` | `web_fetch_tool_call` |

---

## 17. Errors, rejection reasons, and edge cases

### 17.1 Reason strings observed in the reference client

| Reason | Emitted when |
| --- | --- |
| `User Rejected` | Generic denial; the default everywhere. |
| `Missing web search arguments` | `web_search_request_query.args` was absent. |
| `Missing web-search query payload` | The query value itself was absent (ACP). |
| `Web search is disabled in this environment` | Environment kill switch (§12.2), on every surface. |
| `Web search requires host approval` | CLI subagent with no host handler. |
| `Side question cannot search the web` | Side-question surface. |
| `Cancelled` | ACP permission request cancelled. |
| `User rejected` | ACP explicit reject (differing capitalisation from the generic string). |
| `Unknown response` | ACP permission RPC returned an unrecognised outcome. |
| `Conversation stopped` | All pending prompts rejected because the user stopped the turn. |

### 17.2 Failure modes to handle

- **Absent `args`.** Reject rather than approve; an empty search term would otherwise be sent.
- **Empty search term with present `args`.** Treated as the empty string throughout — the prompt
  renders an empty subject and an allowlist comparison against `WebSearch()` would succeed. Guard
  if that matters to you.
- **Unanswered query.** Hangs the turn. There is no server-side timeout. Always answer.
- **Turn cancellation while a prompt is open.** Reject every pending prompt with a reason rather
  than dropping the response.
- **Concurrency.** Like the fetch prompt, the search prompt does not take the
  "one interaction at a time" lock that the mode-switch and ask-question prompts do, so several can
  be outstanding at once. Key your pending-decision store by query `id`.
- **Zero results.** Arrives as `success` with an empty `references` list, not as an error.

---

## 18. Minimum viable web-search client

Everything above, assembled. The search-specific portion is about fifteen lines.

```
# ---- 1. Authenticate (§2) --------------------------------------------------
token = auth_token_from_env_or_flag()
if token is null and api_key is not null:
    token, refresh = post_json(api_url + "/auth/exchange_user_api_key", body={},
                               headers={Authorization: "Bearer " + api_key})
if token is null:
    verifier  = base64url_nopad(random_bytes(32))
    challenge = base64url_nopad(sha256(ascii(verifier)))
    uuid      = uuid_v4()
    open_browser(website_url + "/loginDeepControl?challenge=" + challenge +
                 "&uuid=" + uuid + "&mode=login&redirectTarget=cli")
    token, refresh = poll_until_authorized(api_url, uuid, verifier)   # §2.1 parameters
persist_credentials(token, refresh, api_key)

# ---- 2. Bootstrap (§4) -----------------------------------------------------
config     = call("aiserver.v1.ServerConfigService/GetServerConfig", {})
ghost_mode = resolve_privacy_mode()            # fail closed to true
agent_host = select_agent_host(api_url, ghost_mode, config, using_http1)

# ---- 3. Pick a model (§4) --------------------------------------------------
usable  = call("aiserver.v1.AiService/GetUsableModels", { customModelIds: [] })   # fatal on error
default = try_call("aiserver.v1.AiService/GetDefaultModelForCli", {})             # soft
model   = user_choice ?? default?.model ?? usable.models[0]
if model is null: fail("No model found.")

# ---- 4. Open the stream (§5) -----------------------------------------------
stream = open_bidi(agent_host, "agent.v1.AgentService/Run", headers = stamp_headers())
send(stream, { run_request: {
        conversationState: {},
        action: { userMessageAction: { userMessage: { text: prompt,
                                                      messageId: uuid_v4(),
                                                      mode: "AGENT_MODE_AGENT" },
                                       requestContext: minimal_context() } },
        modelDetails: model,
        conversationId: uuid_v4() } })
start_heartbeat(stream, every = 5000ms)
start_stall_detector(threshold = 30000ms)

# ---- 5. The loop -----------------------------------------------------------
for frame in stream:
    reset_stall_detector()

    match frame.message:

      # --- approval (§8) ---
      case interaction_query where query.web_search_request_query as q:
          if q.args is null:
              reply_rejected(query.id, "Missing web search arguments"); continue

          if eval_hardening_active():                          # §12.2, first and unconditional
              reply_rejected(query.id, "Web search is disabled in this environment"); continue

          if is_run_everything or config.autoAcceptWebSearch:
              reply_approved(query.id); continue

          if can_prompt:
              choice = ask_user("Allow this web search?", q.args.searchTerm)
              if choice == ALLOW: reply_approved(query.id)
              else:               reply_rejected(query.id, "User Rejected")
          else:
              reply_rejected(query.id, "User Rejected")

      # --- any other interaction query: never leave it unanswered ---
      case interaction_query:
          reply_rejected_for_that_query_type(query.id, "Not supported by this client")

      # --- display (§13) ---
      case interaction_update where update.tool_call_completed as t
                               and t.toolCall.tool is web_search_tool_call as w:
          match w.result.result:
              case success:  render_references(w.result.success.references)   # title, url, chunk
              case error:    render_error(w.result.error.error)
              case rejected: render_note(w.result.rejected.reason)

      case interaction_update where update.text_delta as d:
          append_output(d.text)

      case interaction_update where update.turn_ended:
          break

      # --- exec channel: nothing search-related arrives here, but answer anyway ---
      case exec_server_message:
          send(stream, { exec_client_control_message: { throw: { id: exec.id,
                          error: "Tool not implemented by this client" } } })
```

The two helpers:

```
reply_approved(id)         → interaction_response { id, webSearchRequestResponse: { approved: {} } }
reply_rejected(id, reason) → interaction_response { id, webSearchRequestResponse: { rejected: { reason } } }
```

To add ACP-style term allowlisting, insert a `matches_web_search_entry` scan (§9) over
`permissions.allow` between the auto-accept check and the prompt, and persist
`WebSearch({term})` when the user chooses "allow always".

A client that wants no searching at all should send
`x-cursor-agent-exclude-tools: web_search_tool_call` (§12.1) and delete the approval branch.

---

## 19. Open questions

1. **Which search provider, and with what freshness?** Entirely server-side and unobservable.
   Neither the number of references nor a relevance score is exposed.
2. **What is `RunWebSearchRequest.explanation` for?** Declared, never populated in the
   distribution. Plausibly a rationale string for logging or for query rewriting.
3. **Does `model_id` on the direct RPC change results, or only the synthesised `answer`?** The
   in-conversation tool returns no answer at all, which suggests the model is used for synthesis
   only. `[INFERRED]`
4. **Is `WebSearchResult.is_final` (the IDE flavour) ever set false in practice?** It implies
   incremental reference streaming that the CLI surface does not expose.
5. **Where is the year-guidance text consumed?** No in-bundle caller (§15).
6. **Can a `preToolUse` hook block a server-executed search?** See §12.3.
7. **Why is there no search precheck?** The absence is consistent with the exact-match allowlist
   being ACP-only, but whether the server would ever ask is unknown.
8. **JSON mode against the agent endpoint.** Unproven for the whole agent path (§3).

---

## 20. Constants quick reference

| Constant | Value |
| --- | --- |
| Allow-entry grammar | `WebSearch(<exact term>)`, regex `/^\s*WebSearch\s*\(([\s\S]*)\)\s*$/`, inner value trimmed |
| Match semantics | exact, case-sensitive, trimmed string equality; newlines permitted |
| Allowlist honoured by | ACP surfaces only |
| `InteractionQuery` / `InteractionResponse` field | 2 |
| `ToolCall` oneof field | 18, `web_search_tool_call` |
| Exec channel | none |
| IDE tool enum | `CLIENT_SIDE_TOOL_V2_WEB_SEARCH = 18` |
| IDE oneof fields | `web_search_params` 26 · `web_search_result` 27 · `web_search_stream` 28 |
| Tool-gating header names | `x-cursor-agent-allowed-tools`, `x-cursor-agent-exclude-tools` |
| Tool-gating value for this tool | `web_search_tool_call` |
| Direct RPC | `aiserver.v1.AiService/RunWebSearch` |
| Standing auto-approve setting | `autoAcceptWebSearch`, default `false` |
| Config file | `{CURSOR_CONFIG_DIR ?? $XDG_CONFIG_HOME/cursor ?? ~/.cursor}/cli-config.json` |
| Kill-switch env vars | `CURSOR_FORCED_SHELL_EGRESS`, `CURSOR_FORCED_SHELL_EGRESS_ALLOW_WEB_TOOLS` |
| Falsy env values | `""`, `"0"`, `"false"`, `"off"` (trimmed, lowercased) |
| Approval modes | `allowlist` (default) · `unrestricted` · `auto-review` |
| Heartbeat / stall detector | 5000 ms fixed interval · 30 000 ms no-inbound threshold |
| Auth poll | 150 attempts, `min(1000 × 1.2^n, 10000)` ms, 3 consecutive failures |
| JWT refresh margin | 300 s |
