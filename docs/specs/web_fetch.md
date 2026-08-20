# The WebFetch Tool — Clean-Room Implementation Specification

**Target:** an independent client that can (1) authenticate a user, (2) open an authenticated
ConnectRPC transport to the Cursor backend, (3) select a model, (4) run a conversation turn, and
(5) participate correctly in the **`web_fetch`** tool round trip — approving or denying URL
retrieval, answering the server's allowlist precheck, and rendering the result.

**Method:** derived by black-box reading of an unpacked distribution of the official CLI
(build identifier `2026.08.11-e8db854`). Nothing here is source text. Everything is expressed as
protocol facts, message schemas, decision tables, and pseudocode. Protobuf field names and numbers
come from descriptor metadata, which is public wire-format information.

**Relationship to `spec.md`:** this document is self-contained for the web-fetch path, but it
compresses the transport, authentication, and model-discovery chapters to the minimum a fetch
client needs. `spec.md` in this repository is the full protocol reference; section pointers of the
form *(spec §N)* are given where more detail exists.

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
7. [Lifecycle of one fetch](#7-lifecycle-of-one-fetch)
8. [The allowlist precheck exec](#8-the-allowlist-precheck-exec)
9. [The approval decision](#9-the-approval-decision)
10. [Domain matching](#10-domain-matching)
11. [Permission storage and persistence](#11-permission-storage-and-persistence)
12. [Surface-specific policy](#12-surface-specific-policy)
13. [Disabling and gating the tool](#13-disabling-and-gating-the-tool)
14. [Rendering the tool call](#14-rendering-the-tool-call)
15. [The direct RPC: `RunWebFetch`](#15-the-direct-rpc-runwebfetch)
16. [Adjacent tools that are not this tool](#16-adjacent-tools-that-are-not-this-tool)
17. [Errors, rejection reasons, and edge cases](#17-errors-rejection-reasons-and-edge-cases)
18. [Minimum viable web-fetch client](#18-minimum-viable-web-fetch-client)
19. [Open questions](#19-open-questions)
20. [Constants quick reference](#20-constants-quick-reference)

---

## 1. What the tool actually is

`web_fetch` takes a URL, retrieves the page, converts it to Markdown, and hands the Markdown to the
model. The single most important architectural fact for an implementer:

> **The client never makes the HTTP request.** `web_fetch` is a **server-executed** tool. The
> backend performs the retrieval and the Markdown conversion. The client's entire role is
> **policy** — deciding whether the URL may be fetched — plus **display**. `[CONFIRMED]`

This has three consequences that shape everything below.

- There is no user-agent, redirect policy, robots handling, content-type negotiation, size cap, or
  fetch timeout to implement client-side. Those all live server-side and are not observable from
  the distribution.
- A client that answers "approved" to every request is protocol-complete for this tool. A client
  that never answers **hangs the turn** — an unanswered interaction query is not a soft failure.
- The user's machine is never the network origin of the request. Allowlists are therefore an
  *intent* control, not a network control; nothing in the client can prevent the backend from
  reaching a host.

Three distinct client obligations exist in the fetch path, and conflating them produces a client
that appears to work and then deadlocks:

| Obligation | Channel | Trigger | Reply required |
| --- | --- | --- | --- |
| **Approval** | `interaction_query` / `interaction_response` | `web_fetch_request_query` | **Yes**, always. |
| **Allowlist precheck** | `exec_server_message` / `exec_client_message` | `web_fetch_allowlist_precheck_args` | **Yes**, always. |
| **Display** | `interaction_update` | `tool_call_started` / `tool_call_completed` carrying `web_fetch_tool_call` | No. |

---

## 2. Prerequisite: authentication

*(spec §5, §6 for the full treatment.)*

Three mutually exclusive credential sources, in precedence order `[CONFIRMED]`:

1. **Raw auth token** — CLI flag or `CURSOR_AUTH_TOKEN`. Used verbatim as both access and refresh
   token. No exchange, no refresh path.
2. **API key** — CLI flag or `CURSOR_API_KEY`. Exchanged for a token pair (§2.2 below).
3. **Interactive browser login** (§2.1 below).

If all three fail, the client must abort with an authentication-required error. There is **no
unauthenticated path** to model listing or to the agent stream, and therefore none to `web_fetch`.

### 2.1 Browser login — a PKCE-shaped flow that is not OAuth `[CONFIRMED]`

It resembles OAuth 2.0 PKCE with a device-flow poll, but it is **not RFC-compliant OAuth**: there
is no `client_id`, no `/token` endpoint, no `grant_type`, no scopes, and the poll returns the token
pair directly as JSON. Implement it as described, not as an OAuth library call.

**Step 1 — generate the challenge.**

```
verifier  = base64url_nopad(random_bytes(32))
challenge = base64url_nopad(sha256(ascii_bytes_of(verifier)))
uuid      = uuid_v4()
```

`base64url_nopad` is standard base64 with `+`→`-`, `/`→`_`, and all `=` padding stripped. The
SHA-256 is taken over the **characters of the base64url verifier string**, not over the 32 raw
random bytes. Getting this wrong produces a poll that never succeeds.

**Step 2 — send the user to the authorization page.**

```
{websiteUrl}/loginDeepControl?challenge={challenge}&uuid={uuid}&mode=login&redirectTarget=cli
```

Open it in a browser, and also print it as text (and optionally as a QR code) so the user can
authorize from another device. There is **no local callback listener** — the browser never
redirects back to the client.

**Step 3 — poll until authorized.**

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
| Consecutive-failure budget | 3, then abort as "not authenticated" |

Response handling:

- **`404`** — not yet authorized. This is the normal waiting signal: reset the consecutive-failure
  counter, sleep the backoff, retry.
- **`403`** whose JSON body has `error == "sign_in_policy_violation"` — a managed-device policy
  rejection. Abort immediately; do not retry.
- **`2xx`** with a body containing both `accessToken` and `refreshToken` — success. Extra members
  may be present and must be ignored.
- Anything else, including transport errors — increment the consecutive-failure counter, abort at
  3, otherwise back off and retry.

Check the abort signal at the top of every iteration.

### 2.2 API key exchange `[CONFIRMED]`

```
POST {apiUrl}/auth/exchange_user_api_key
Content-Type: application/json
Authorization: Bearer {apiKey}

{}
```

The body is an empty JSON object; the key travels in the header. `2xx` returns
`{accessToken, refreshToken}`. A `403` with `error == "sign_in_policy_violation"` is fatal; any
other `403` means an invalid key; `>= 500` is a retryable network failure.

Persist `(accessToken, refreshToken, apiKey)` together — the key is the only thing that enables
silent re-exchange later.

### 2.3 Token lifetime `[CONFIRMED]`

The access token is a JWT. Expiry is evaluated locally with a 300-second safety margin:

```
function is_expiring_soon(jwt):
    try:
        payload = json_parse(base64_decode(second_segment_of(jwt)))
        return (payload.exp - now_unix_seconds()) < 300
    except:
        return true                # unparseable ⇒ treat as expired
```

**Important asymmetry.** The only refresh mechanism in the reference client is "re-run the API-key
exchange". The stored `refreshToken` is persisted but never redeemed against any observed endpoint.
A session established purely by browser login therefore has **no working refresh path**; when the
JWT expires the user must sign in again. Drive long-lived automation from an API key.

### 2.4 Credential storage `[CONFIRMED]`

Backend selected by `AGENT_CLI_CREDENTIAL_STORE`: `memory`, `file`, or unset/`default` (OS keychain
on macOS, file elsewhere).

File backend path, for a domain string equal to the client's own name: `~/.{domain}/auth.json` on
macOS, `%APPDATA%\{Domain}\auth.json` on Windows, `${XDG_CONFIG_HOME:-~/.config}/{domain}/auth.json`
otherwise. Directory mode `0700`, file mode `0600`, enforced on every write. Content is a JSON
object with `accessToken`, `refreshToken`, `apiKey`, and optional `bedrockCredentials`.

The macOS keychain is deliberately avoided when the session looks like SSH and the process is not
in CI, because keychain access over SSH raises a GUI prompt nobody can answer.

---

## 3. Prerequisite: transport and headers

*(spec §2, §3, §4, §8.)*

### 3.1 Endpoints `[CONFIRMED]`

| Environment | API URL | Website URL |
| --- | --- | --- |
| `prod` (default) | `https://api2.cursor.sh` | `https://cursor.com` |
| `staging` | `https://staging.cursor.sh` | `https://staging.cursor.sh` |
| `playground` | `https://api.playground.cursor.sh` | `https://playground.cursor.com` |

Overrides: `CURSOR_API_ENDPOINT` (and `CURSOR_API_BASE_URL`, read independently by the auth module),
`CURSOR_WEBSITE_URL`. Matching an origin against either column of a row adopts the whole row.
Reject URLs carrying a fragment, query, username, or password. Strip trailing slashes.

### 3.2 Wire protocol `[CONFIRMED]`

ConnectRPC over protobuf. Every call is `POST {baseUrl}/{fully.qualified.Service}/{Method}`.

The reference client uses **binary** protobuf with gzip on the agent path. Connect also defines a
JSON mode (`application/json` for unary, `application/connect+json` for streams) which is far
cheaper to implement, but it has **not been observed** against the agent endpoints — validate it
with one live call before committing. Stream framing in JSON mode is a 5-byte envelope: one flag
byte, then a big-endian `uint32` payload length, then the payload; a frame with `flags & 0x02` is
the terminal frame and its JSON payload carries an `error` member on failure.

### 3.3 Headers stamped on every request `[CONFIRMED]`

| Header | Value |
| --- | --- |
| `authorization` | `Bearer {accessToken}`; omitted when absent |
| `x-ghost-mode` | `"true"` / `"false"`; **fails closed to `"true"`** |
| `x-request-id` | fresh UUID v4 per attempt, regenerated on retry |
| `x-original-request-id` | UUID v4, stable across all retries of one logical run |
| `x-cursor-client-version` | `cli-{version}` (plus `-{channel}` off prod) |
| `x-cursor-client-type` | surface identifier; `cli`, `interactive`, `acp`, `cloud`, … |
| `x-cursor-streaming` | `"true"`, HTTP/1.1 agent transport only |

Two headers are specific to tool gating and matter directly here — see §13:
`x-cursor-agent-allowed-tools` and `x-cursor-agent-exclude-tools`.

### 3.4 Transport selection `[CONFIRMED]`

HTTP/2 is the default; `GetServerConfig` can force either version. On HTTP/1.1 the bidi `Run`
method is emulated: downstream becomes `AgentService/RunSSE`, upstream becomes a sequence of unary
`aiserver.v1.BidiService/BidiAppend` calls correlated by `x-request-id` and ordered by
`append_seqno`. Prefer HTTP/2 and true bidi; implement the shim only if forced through an
HTTP/1.1-only proxy.

---

## 4. Prerequisite: bootstrap and model selection

*(spec §7, §10.)*

Before the first turn:

1. `aiserver.v1.ServerConfigService/GetServerConfig` — transport selection and feature flags.
2. `aiserver.v1.DashboardService/GetUserPrivacyMode` — the `x-ghost-mode` value. Resolve this
   **before** choosing the agent host, because ghost mode selects between two agent hosts.
3. `aiserver.v1.DashboardService/GetMe` — identity. Lazy.
4. Model discovery.

Model discovery issues three RPCs **concurrently** and merges them:

| RPC | Service | Role | Failure |
| --- | --- | --- | --- |
| `GetUsableModels` | `AiService` | Authoritative allow-list. | **Fatal.** |
| `GetDefaultModelForCli` | `AiService` | Recommended default. | Soft. |
| `AvailableModels` | `AiService` | Rich catalogue: capabilities, context limits, parameters. | Soft; bounded at 2000 ms. |

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
  oneof credentials {                        // BYOK only
    ApiKeyCredentials  api_key_credentials  = 8;
    AzureCredentials   azure_credentials    = 9;
    BedrockCredentials bedrock_credentials  = 10;
  }
}
```

An empty `models` list means "no data", not "no models". Models are presented in the exact order
returned — no sorting. The alias map is rebuilt after each fetch by lowercasing `model_id`,
`display_model_id`, `display_name`, `display_name_short`, and every entry of `aliases`, all mapping
to the same `ModelDetails`.

For the web-fetch path, **any model that reports `supports_agent` is sufficient**. The tool is
server-side, so no model capability flag gates it. Pass the chosen `ModelDetails` in
`AgentRunRequest.model_details`; for a parameterised selection also set `requested_model`.

---

## 5. Prerequisite: opening the run stream

*(spec §11.)*

`agent.v1.AgentService/Run` is bidi-streaming.

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

The first client message must be exactly one `run_request`, carrying `conversation_state` (an empty
`ConversationStateStructure` for a new conversation), `action` (a `ConversationAction` wrapping a
`UserMessageAction`), `model_details`, and a generated `conversation_id`.

Two traps: `ttft_breakdown` lives outside the oneof and may accompany any frame; and there is **no
error case in `AgentServerMessage`** — failures arrive as ConnectRPC stream errors, never as a
protobuf frame.

Liveness: start a **fixed 5000 ms** heartbeat timer as soon as the stream is wired (it is not an
idle timer and is not reset by other outbound traffic), and abort the stream if **30 000 ms** pass
with no inbound frame of any kind. A server heartbeat resets the stall detector.

Two messages arriving on this stream are the entire web-fetch protocol: an `interaction_query`
carrying `web_fetch_request_query`, and an `exec_server_message` carrying
`web_fetch_allowlist_precheck_args`.

---

## 6. Message catalogue

### 6.1 Core tool types — package `agent.v1` `[CONFIRMED]`

```proto
message WebFetchArgs {
  string url          = 1;
  string tool_call_id = 2;    // matches ToolCall.tool_call_id (field 57), not call_id
}

message WebFetchResult {
  oneof result {
    WebFetchSuccess  success  = 1;
    WebFetchError    error    = 2;
    WebFetchRejected rejected = 3;
  }
}

message WebFetchSuccess {
  string url                            = 1;
  string markdown                       = 2;   // page content, converted server-side
  optional OutputLocation output_location = 3; // set when the payload was spilled to a file
}

message WebFetchError    { string url = 1; string error  = 2; }
message WebFetchRejected {                  string reason = 1; }

message WebFetchToolCall {
  WebFetchArgs   args   = 1;
  WebFetchResult result = 2;
}

message OutputLocation {
  string file_path  = 1;
  int64  size_bytes = 2;
  int64  line_count = 3;
}
```

`OutputLocation` is a shared "the output was too large to inline, here is where it landed"
descriptor used elsewhere for shell and MCP output. Its meaning for a server-executed fetch is
`[INFERRED]`; the reference client's fetch renderer ignores it.

### 6.2 Approval types — package `agent.v1` `[CONFIRMED]`

```proto
message WebFetchRequestQuery {
  WebFetchArgs      args                = 1;
  bool              skip_approval       = 2;
  SmartModeApproval smart_mode_approval = 3;
}

message WebFetchRequestResponse {
  oneof result {
    Approved approved = 1;   // empty message
    Rejected rejected = 2;   // { string reason = 1; }
  }
}

message SmartModeApproval { string request_id = 1; string reason = 2; }
```

`smart_mode_approval` is populated by the Auto-review (smart-mode) classifier path. The reference
client **reads it for shell and MCP prompts but not for web fetch** — the fetch prompt renders no
classifier reason. `[CONFIRMED]`

### 6.3 Precheck types — package `agent.v1` `[CONFIRMED]`

```proto
message WebFetchAllowlistPrecheckArgs {
  string url                    = 1;
  optional string tool_call_id  = 2;
}
message WebFetchAllowlistPrecheckResult { bool allowlisted = 1; }
```

### 6.4 Field numbers on the shared envelopes `[CONFIRMED]`

| Envelope | Field | # |
| --- | --- | --- |
| `InteractionQuery.query` | `web_fetch_request_query` | 9 |
| `InteractionResponse.result` | `web_fetch_request_response` | 9 |
| `ToolCall.tool` | `web_fetch_tool_call` | 37 |
| `ExecServerMessage.message` | `web_fetch_allowlist_precheck_args` | 43 |
| `ExecClientMessage.message` | `web_fetch_allowlist_precheck_result` | 43 |

`InteractionQuery.id` and `InteractionResponse.id` are `uint32` and must match. Query and response
field numbers are deliberately parallel across all interaction types. Similarly, both
`ExecServerMessage` and `ExecClientMessage` carry `uint32 id = 1` and `string exec_id = 15`, and a
reply must echo both.

### 6.5 The three correlation ids

They are not interchangeable, and the fetch path touches all three. `[CONFIRMED]`

| Id | Scope |
| --- | --- |
| `call_id` | Transport-level; spans `partial_tool_call` → `started` → `completed`. |
| `model_call_id` | The id the underlying LLM assigned to the call. |
| `ToolCall.tool_call_id` (field 57) | Durable id used in history and in interaction/exec messages. **This** is what `WebFetchArgs.tool_call_id` and `WebFetchAllowlistPrecheckArgs.tool_call_id` carry. |

---

## 7. Lifecycle of one fetch

The observed ordering for a single `web_fetch` invocation, from the client's point of view:

1. **Streaming arguments (optional).** Zero or more `interaction_update.partial_tool_call` frames
   arrive with `args_text_delta` as the model emits the URL. Display only.
2. **Precheck (optional, server's discretion).** An `exec_server_message` carrying
   `web_fetch_allowlist_precheck_args` asks: *is this URL fully allowlisted on your side?* The
   client must reply with a matching `exec_client_message` carrying
   `web_fetch_allowlist_precheck_result`. See §8.
3. **Approval.** An `interaction_query` carrying `web_fetch_request_query` arrives. The client must
   reply with an `interaction_response` carrying `web_fetch_request_response`, echoing `id`. See §9.
   If the precheck answered `allowlisted = true`, the server is expected to set
   `skip_approval = true` on this query. `[INFERRED]`
4. **Execution.** On approval, the backend performs the retrieval and Markdown conversion. The
   client does nothing.
5. **Start notification.** `interaction_update.tool_call_started` with a `ToolCall` whose oneof case
   is `web_fetch_tool_call`; `args.url` is populated, `result` is not.
6. **Completion.** `interaction_update.tool_call_completed` with the same `call_id`, now carrying a
   populated `WebFetchResult`: `success` (with `markdown`), `error` (with a message), or `rejected`
   (with a reason mirroring what the client sent).
7. The turn continues; eventually `turn_ended`.

Steps 2 and 3 are the only ones with a mandatory client reply. Note that on rejection the server
still narrates the tool call — you will see a `tool_call_completed` whose result case is `rejected`,
carrying the reason string the client supplied. Do not treat that as an error.

There is no observed client-side deadline on the approval query. Unlike the mode-switch prompt,
which carries an explicit deadline, the fetch prompt waits indefinitely for the user. A headless
implementation must therefore decide synchronously rather than blocking.

---

## 8. The allowlist precheck exec

The precheck lets the server discover, before it interrupts the user, whether the client would
auto-approve this URL anyway. It is a client-executed exec like any other: one request, exactly one
terminal reply, same `id` and `exec_id`.

The reference implementation of the answer `[CONFIRMED]`:

```
function is_web_fetch_fully_allowlisted(url):
    permissions = load_permissions()                  # from the CLI config file, §11

    # Only the strict allowlist mode can produce a meaningful "yes".
    if permissions.approvalMode != "allowlist":
        return false

    try:    parsed = parse_url_strict(url)            # a real URL parser; no scheme guessing
    except: return false

    host = parsed.hostname

    if any(entry in permissions.deny  where matches_web_fetch_entry(entry, host)): return false
    return any(entry in permissions.allow where matches_web_fetch_entry(entry, host))
```

```
function matches_web_fetch_entry(entry, host):
    # entry looks like:  WebFetch(<pattern>)   with arbitrary surrounding whitespace
    m = regex_match(entry, /^\s*WebFetch\s*\((.*)\)\s*$/)
    if not m: return false
    return domain_matches(host, trim(m.group(1)))     # §10
```

Three details worth calling out, because they are easy to get wrong and they are observable
behaviour, not implementation freedom:

- **`approvalMode` is read raw, not resolved.** In `unrestricted` ("Run Everything") or
  `auto-review` mode the precheck answers `false`, even though the subsequent approval query will be
  auto-approved locally. The precheck answers a narrower question than "will you approve this".
- **Deny wins, and deny is only consulted here.** The in-process approval check (§9) consults only
  the `allow` list. The `deny` list is honoured in the precheck path. A URL can therefore be denied
  for precheck purposes and still be approved by the prompt path. `[CONFIRMED]`
- **Strict URL parsing.** The precheck uses a real URL parser with no `https://` prefixing. A bare
  `example.com` fails to parse and answers `false`, whereas the approval path (§10) *does* prefix a
  scheme before extracting the host. The two paths do not normalise identically.

Reply shape:

```
on exec_server_message with web_fetch_allowlist_precheck_args:
    send exec_client_message {
        id      = request.id,
        exec_id = request.exec_id,
        web_fetch_allowlist_precheck_result = { allowlisted: <bool> }
    }
```

A client with no allowlist concept should answer `false` and rely on the approval query. Declining
an exec entirely is done with `exec_client_control_message.throw` carrying the matching `id`, but
for this exec, answering `false` is strictly better — a thrown exec is an error condition.

---

## 9. The approval decision

### 9.1 The decision function `[CONFIRMED]`

```
function decide_web_fetch(query, options):
    # 1. Server-side skip, explicit force, or Run Everything mode.
    if query.skip_approval or options.force_approve or options.is_run_everything:
        return APPROVED

    # 2. Allowlist hit on the host.
    host = host_of(query.args.url)                  # §10.1, lenient parsing
    if any(entry in permissions.allow where matches_web_fetch_entry(entry, host)):
        return APPROVED

    # 3. Ask, if this surface can ask.
    if options.allow_prompt:
        return prompt_user(host, query.args.url)    # §9.3

    # 4. Otherwise decline with a specific reason.
    return REJECTED("Domain not in allowlist")
```

If the prompt path is selected but the surface supplies no prompt callback, the result is
`REJECTED("User Rejected")`.

### 9.2 What `is_run_everything` means `[CONFIRMED]`

It is not simply "the user passed `--force`". The user's `approvalMode` setting is resolved against
team administrator controls before it takes effect:

```
function resolve_approval_mode(setting, team_controls, sandbox_available):
    switch setting:
        case "allowlist":
            return "allowlist"
        case "unrestricted":
            # Team admins can disable Run Everything for the whole org.
            allowed = not (team_controls.enabled == true and team_controls.enableRunEverything != true)
            return allowed ? "unrestricted" : "allowlist"
        case "auto-review":
            allowed = not (team_controls.enabled == true and team_controls.enableSmartAuto != true)
            return (allowed and classifier_model_available) ? "auto-review" : "allowlist"

is_run_everything = (resolved == "unrestricted")
```

The team-controls lookup is memoised per provider and **fails open** — if the settings RPC throws,
the mode is allowed. `[CONFIRMED]`

`--force` and its alias `--yolo` set the setting to `unrestricted`; `--auto-review` sets
`auto-review` and is mutually exclusive with `--force`. If a team admin has disabled Run Everything,
the reference client exits with an explanatory error rather than silently downgrading.

### 9.3 The interactive prompt `[CONFIRMED]`

| Element | Value |
| --- | --- |
| Question | `Allow this web fetch?` |
| Primary detail | the URL |
| Option 1 | `Fetch` — hint `(y)`, action *approve* |
| Option 2 | `Always allow {host}` — hint `(tab)`, action *allowlist-domain-approve* |
| Option 3 | `Skip` — hint `(esc or n)`, action *reject* |
| Default on dismissal | *reject* (not *propose*, unlike shell and write prompts) |

Choosing *always allow* persists `WebFetch({host})` into the allow list (§11) **and** approves the
current request. The web-fetch prompt has no "reject and propose changes" affordance and shows no
Auto-review classifier reason.

Two analytics events bracket the prompt: a request event with `tool = "web-fetch"` and
`type = "approval"`, and a response event with `response = "approved"` or the rejection outcome.

### 9.4 Building the response

```
approved:  InteractionResponse { id: query.id,
             web_fetch_request_response: { approved: {} } }

rejected:  InteractionResponse { id: query.id,
             web_fetch_request_response: { rejected: { reason: <string> } } }
```

The reason string is surfaced back to the model and echoed into
`WebFetchResult.rejected.reason`, so make it actionable — the reference client uses
`"User Rejected"` as its generic default and more specific strings where the cause is known (§17).

---

## 10. Domain matching

This is the one genuinely intricate algorithm in the tool, and it is shared by the precheck path,
the approval path, and the persistence path. It is a pure function over `(host, pattern)`.

### 10.1 Host extraction (lenient) `[CONFIRMED]`

```
function host_of(text):
    t = trim(text)
    if t is empty: return ""
    candidate = t contains "://" ? t : "https://" + t   # scheme-less input is assumed https
    try:    return normalize_host(parse_url(candidate).hostname)
    except: return normalize_host(t)                    # unparseable ⇒ use the raw string

function normalize_host(h):
    h = lowercase(trim(h))
    if h starts with "[" and ends with "]": h = strip_brackets(h)   # IPv6 literal
    return h
```

Note the fallback: an unparseable input becomes its own "host". That makes matching total — it
never throws — at the cost of matching nonsense against nonsense.

### 10.2 Pattern matching `[CONFIRMED]`

```
function domain_matches(host, pattern):
    h = normalize_host(host)
    p = normalize_host(pattern)

    if p == "*":            return true              # match everything
    if p contains "/":      return cidr_match(h, p)  # CIDR block
    if p starts with "*.":
        base = p[2:]
        return h == base or h ends_with ("." + base) # host itself plus all subdomains
    return h == p                                    # exact, case-insensitive
```

Four pattern forms, then. `*` is a wildcard for every host. `*.example.com` matches
`example.com` **and** every subdomain — note that the bare apex is included, which is not what a
literal glob would do. `10.0.0.0/8` matches an IP range. Anything else is an exact host comparison.
There is no partial-path matching: patterns describe **hosts**, never paths, so
`WebFetch(github.com)` authorises the entire host.

### 10.3 CIDR matching `[CONFIRMED]`

```
function cidr_match(host, pattern):
    slash = last_index_of(pattern, "/")
    if slash <= 0 or slash == length(pattern) - 1: return false

    net  = parse_ip(pattern[:slash])
    addr = parse_ip(host)
    if net is null or addr is null:      return false
    if net.version != addr.version:      return false

    bits     = to_integer(pattern[slash+1:])
    max_bits = (net.version == 4) ? 32 : 128
    if bits is not an integer or bits < 0 or bits > max_bits: return false

    shift = max_bits - bits
    return (addr.value >> shift) == (net.value >> shift)
```

`parse_ip` accepts IPv4 first, then IPv6:

- **IPv4** — exactly four dot-separated groups, each 1–3 digits, each numerically 0–255. Packed
  big-endian into a 32-bit value. Leading-zero forms like `010` are accepted as decimal 10.
- **IPv6** — lowercase, brackets already stripped. Reject if it contains `:::`. At most one `::`
  compression group. Each non-empty group is 1–4 hex digits; a group containing a dot is only legal
  as the final group and must be a valid IPv4 quad, contributing two 16-bit words. An uncompressed
  address must yield exactly 8 words; a compressed one must yield at most 7 before zero-filling.
  Packed into a 128-bit value.

Arbitrary-precision arithmetic is required for the IPv6 case.

### 10.4 Worked examples

| Pattern | `docs.example.com` | `example.com` | `evil-example.com` | `10.1.2.3` |
| --- | --- | --- | --- | --- |
| `example.com` | no | yes | no | no |
| `*.example.com` | yes | **yes** | no | no |
| `*` | yes | yes | yes | yes |
| `10.0.0.0/8` | no | no | no | yes |
| `10.0.0.0/33` | no | no | no | no (invalid prefix) |

---

## 11. Permission storage and persistence

### 11.1 Where it lives `[CONFIRMED]`

Config file: `{configDir}/cli-config.json`, where `configDir` is `CURSOR_CONFIG_DIR`, else
`$XDG_CONFIG_HOME/cursor`, else `~/.cursor`.

Relevant members:

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `permissions.allow` | string[] | `[]` | Entries like `WebFetch(example.com)`, `Shell(git status)`, `Mcp(server:tool)`, `Write(path)`. |
| `permissions.deny` | string[] | `[]` | Same grammar; consulted by the precheck path. |
| `approvalMode` | `"allowlist"` \| `"unrestricted"` \| `"auto-review"` | `"allowlist"` | See §9.2. |
| `autoAcceptWebSearch` | bool | `false` | Web **search** only; has no effect on fetch. |
| `webFetchDomainAllowlist` | string[] | `[]` | Legacy/migration input; see §11.3. |

The allow list is a flat array of typed entries distinguished by their `Kind(...)` prefix. Web fetch
owns the `WebFetch` kind and the value is always a **host pattern** in the §10 grammar.

### 11.2 Persisting an "always allow" `[CONFIRMED]`

```
function allowlist_domain(permissions_provider, kind, value):
    entry = kind + "(" + value + ")"                 # e.g. WebFetch(docs.example.com)
    update permissions atomically:
        allow = allow already contains entry ? allow : allow + [entry]
```

The dedupe is an exact string comparison, not a semantic one: `WebFetch(example.com)` and
`WebFetch( example.com )` both persist. Matching trims, so both work; only the file gets untidy.

### 11.3 The migration array `[CONFIRMED]`

`webFetchDomainAllowlist` is a plain list of bare domains that exists to seed the typed allow list.
At startup:

```
if webFetchDomainAllowlist is non-empty:
    missing = [d for d in webFetchDomainAllowlist if "WebFetch(" + d + ")" not in permissions.allow]
    if missing is empty:
        clear webFetchDomainAllowlist            # nothing to do, just drop the legacy key
    else:
        permissions.allow += ["WebFetch(" + d + ")" for d in missing]
        clear webFetchDomainAllowlist
```

It is consumed and emptied in one pass. A new client can treat it as an import format and never
write to it.

---

## 12. Surface-specific policy

The same decision function is wrapped differently per surface. This table is the practical answer to
"what will happen to my fetch request". `[CONFIRMED]`

| Surface | Prompting | Behaviour when not allowlisted |
| --- | --- | --- |
| Interactive TUI | yes | Prompts (§9.3); *always allow* persists the host. |
| Headless (`--print`) | no | Approved only if the force/Run-Everything flag is set, or `skip_approval` is true. Otherwise `REJECTED("User Rejected")`. |
| ACP (editor integration) | yes, via the ACP permission RPC | Options `allow-once` / `allow-always` / `reject-once`; `allow-always` persists `WebFetch(host)`. Cancellation ⇒ `REJECTED("Cancelled")`. A failed permission RPC ⇒ rejection carrying the error message. |
| ACP subagent host | yes | Same policy object, prompt titled `Allow web fetch?` with the URL as description and an `Always allow {host}` affordance. |
| CLI subagent host adapter | no | `REJECTED("Web fetch requires host approval")` unless the host supplies a handler. |
| Side question | no | `REJECTED("Side question cannot fetch web content")`. |

Two ordering details in the ACP path differ from the shared policy and are worth copying if you are
matching behaviour exactly: ACP checks `skip_approval` first, then Run Everything, then the
allowlist, and it emits a distinct debug marker for each. Functionally it is the same ladder as §9.1.

The non-interactive fallback helper — the one used by headless, subagents, and side questions —
inverts the test slightly:

```
if eval_hardening_active() or (not query.skip_approval and not options.approve_web_fetch):
    reject(eval_hardening_active() ? "Web fetch is disabled in this environment"
                                   : options.web_fetch_reject_reason ?? "User Rejected")
else:
    approve()
```

So `skip_approval` alone is enough to approve on every non-interactive surface, and the
environment kill switch (§13.2) overrides everything.

---

## 13. Disabling and gating the tool

### 13.1 Excluding the tool from the session `[CONFIRMED]`

Two request headers gate which tools the server may offer for a session. Values are comma-joined
**`ToolCall` oneof field names**:

| Header | Meaning |
| --- | --- |
| `x-cursor-agent-allowed-tools` | Allow only these tools. |
| `x-cursor-agent-exclude-tools` | Exclude these tools. |

The name for this tool is `web_fetch_tool_call`. The reference client validates supplied names
against the live `ToolCall` oneof field list and refuses to start on an unknown name, so the header
value is exactly the proto field name — not `web_fetch`, not `WebFetch`.

This is the clean way to build a client that must never fetch: exclude the tool rather than reject
its queries, and the model is never offered it in the first place.

### 13.2 The environment kill switch `[CONFIRMED]`

```
function eval_hardening_active():
    forced = truthy(env["CURSOR_FORCED_SHELL_EGRESS"])
    if not forced: return false
    return not truthy(env["CURSOR_FORCED_SHELL_EGRESS_ALLOW_WEB_TOOLS"])

function truthy(v):
    s = lowercase(trim(v ?? ""))
    return s != "" and s != "0" and s != "false" and s != "off"
```

When active, non-interactive surfaces reject with `"Web fetch is disabled in this environment"`.
Both values are memoised on first read, so changing them mid-process has no effect.

Note the asymmetry: the shared policy object applies this check inside its **web search** entry
point but not inside its **web fetch** entry point. For fetch, the check lives in the
non-interactive fallback helper and in the ACP search path. An interactive TUI session therefore
still prompts for fetch under the kill switch. `[CONFIRMED]`

### 13.3 Hooks `[UNVERIFIED]`

The hook subsystem defines `preToolUse` / `postToolUse` events and, when importing Claude-style hook
configurations, maps the tool name `WebFetch` onto its own `WebFetch` matcher. However, every
observed hook enforcement site sits on the **client-executed** tool paths (shell, MCP, file read).
Because `web_fetch` executes server-side, whether a `preToolUse` hook can actually block it is not
determinable from the distribution. Do not rely on hooks as a fetch control; use §13.1.

---

## 14. Rendering the tool call

Purely cosmetic, but these are the observable conventions. `[CONFIRMED]`

| Field | Value |
| --- | --- |
| Tool label | `WebFetch` |
| Primary line | the URL from `args.url` |
| Status | `pending` when `result` is unset, else `success` / `error` / `rejected` from the result oneof |
| Error line | `Error: {WebFetchError.error}`, defaulting to `Unknown error` |
| Rejected note | `WebFetchRejected.reason`, defaulting to `Web fetch rejected` |

Compact renderings elsewhere in the reference client: `Fetching {url}` / `Fetched {url}` in the
condensed transcript, `Fetch {url}` in message summaries, and `Web Fetch: {url}` with an ACP tool
kind of `fetch` in the editor integration.

Note that a missing `args` renders nothing at all — the renderer bails before drawing a header.

---

## 15. The direct RPC: `RunWebFetch`

Separately from the agent stream, the backend exposes a **unary** fetch endpoint. This is the
closest thing to a standalone "upstream connector" for URL retrieval. `[CONFIRMED]` as a declared
method; `[UNVERIFIED]` in behaviour, because the reference CLI declares it and never calls it.

```
POST {apiUrl}/aiserver.v1.AiService/RunWebFetch
```

```proto
message RunWebFetchRequest  { string url = 1; }

message RunWebFetchResponse {
  oneof result {
    RunWebFetchSuccess success = 1;   // { string content = 1; }
    RunWebFetchError   error   = 2;   // { string error = 1; bool is_timeout = 2; }
  }
}
```

Same authentication and headers as any other `AiService` call (§2, §3). Note that this response
says `content`, whereas the agent-stream result says `markdown`; and that it exposes an explicit
`is_timeout` flag which the agent-stream `WebFetchError` does not.

A related pair exists in the IDE-facing tool surface, shaped for streamed tool calls rather than a
unary request:

```proto
message WebFetchParams { string url = 1; }
message WebFetchStream { WebFetchParams params = 1; }
message WebFetchResult {                      // aiserver.v1, distinct from agent.v1's type
  string url               = 1;
  optional string markdown = 2;
  optional string error    = 3;
}
```

Beware the name collision: `aiserver.v1.WebFetchResult` and `agent.v1.WebFetchResult` are different
messages with different shapes. Qualify fully in generated code.

---

## 16. Adjacent tools that are not this tool

Four things in the protocol look like web fetch and are not. `[CONFIRMED]`

| Thing | Package / channel | Who executes | Distinguishing detail |
| --- | --- | --- | --- |
| `web_fetch` | `agent.v1`, interaction + display | **Server** | Returns `markdown`. This document. |
| `fetch` | `agent.v1`, exec channel, args/result field 20 | **Client** | `FetchSuccess` carries `content`, `status_code`, and `content_type` — a raw HTTP fetch performed on the user's machine. `ToolCall` case 24. |
| `web_search` | `agent.v1`, interaction field 2 | Server | Query string, not a URL; gated by `autoAcceptWebSearch` and by `WebSearch(term)` allow entries matched by **exact trimmed string equality**, not domain matching. |
| MCP resource read | `agent.v1`, exec channel | Client, via an MCP server | Addressed by URI and server name, governed by `Mcp(provider:tool)` entries. |

The `fetch` exec is the one to watch: it has almost the same name, the same `{url, tool_call_id}`
argument shape, and the opposite execution model. If your client implements exec handlers, make sure
`fetch_args` and `web_fetch_allowlist_precheck_args` are routed to different code.

---

## 17. Errors, rejection reasons, and edge cases

### 17.1 Reason strings observed in the reference client

| Reason | Emitted when |
| --- | --- |
| `User Rejected` | Generic denial; the default everywhere. |
| `Domain not in allowlist` | Policy declined and the surface could not prompt. |
| `Missing web fetch arguments` | `web_fetch_request_query.args` was absent. |
| `Missing web-fetch query payload` | The query value itself was absent (ACP). |
| `Web fetch is disabled in this environment` | Environment kill switch (§13.2). |
| `Web fetch requires host approval` | CLI subagent with no host handler. |
| `Side question cannot fetch web content` | Side-question surface. |
| `Cancelled` | ACP permission request cancelled. |
| `User rejected` | ACP explicit reject (note the differing capitalisation from the generic string). |
| `Unknown response` | ACP permission RPC returned an unrecognised outcome. |
| `Conversation stopped` | All pending prompts rejected because the user stopped the turn. |

### 17.2 Failure modes to handle

- **Absent `args`.** Reject rather than approve; an empty URL would otherwise be sent to the backend.
- **Unparseable URL.** The lenient host extractor (§10.1) never throws, so an unparseable URL
  produces a nonsense "host" that will not match a sane allowlist and will fall through to a prompt
  or a rejection. The strict precheck parser returns `false`. Both behaviours are safe.
- **Unanswered query.** Hangs the turn. There is no server-side timeout observed. Always answer.
- **Turn cancellation while a prompt is open.** Reject every pending prompt with a reason; do not
  leave the response unsent.
- **Stream teardown.** Interaction responses are ordinary frames on the run stream; if the stream
  dies while a prompt is open, the pending decision is moot, and the retry/resume path (spec §13.2)
  restarts the turn from the last checkpoint.
- **Concurrency.** The web-fetch prompt does not take the "one interaction at a time" lock that the
  mode-switch and ask-question prompts do, so multiple fetch prompts can queue simultaneously. Key
  your pending-decision store by query `id`.

---

## 18. Minimum viable web-fetch client

Everything above, assembled. This is the whole thing; the tool-specific portion is about twenty
lines.

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
config      = call("aiserver.v1.ServerConfigService/GetServerConfig", {})
ghost_mode  = resolve_privacy_mode()          # fail closed to true
agent_host  = select_agent_host(api_url, ghost_mode, config, using_http1)

# ---- 3. Pick a model (§4) --------------------------------------------------
usable  = call("aiserver.v1.AiService/GetUsableModels", { customModelIds: [] })   # fatal on error
default = try_call("aiserver.v1.AiService/GetDefaultModelForCli", {})             # soft
model   = user_choice ?? default?.model ?? usable.models[0]
if model is null: fail("No model found.")

# ---- 4. Open the stream (§5) -----------------------------------------------
stream = open_bidi(agent_host, "agent.v1.AgentService/Run", headers = stamp_headers())
send(stream, { run_request: {
        conversationState: {},                       # new conversation
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

      # --- allowlist precheck (§8) ---
      case exec_server_message where exec.web_fetch_allowlist_precheck_args as a:
          allowlisted = false
          if permissions.approvalMode == "allowlist":
              try:
                  host = strict_parse_url(a.url).hostname
                  allowlisted = not any_match(permissions.deny,  host) \
                                and any_match(permissions.allow, host)
              except: allowlisted = false
          send(stream, { exec_client_message: { id: exec.id, execId: exec.execId,
                         webFetchAllowlistPrecheckResult: { allowlisted: allowlisted } } })

      # --- approval (§9) ---
      case interaction_query where query.web_fetch_request_query as q:
          if q.args is null:
              reply_rejected(query.id, "Missing web fetch arguments"); continue

          if q.skipApproval or is_run_everything:
              reply_approved(query.id); continue

          host = host_of(q.args.url)                       # §10.1
          if any_match(permissions.allow, host):           # §10.2
              reply_approved(query.id); continue

          if can_prompt:
              choice = ask_user("Allow this web fetch?", q.args.url, host)
              if choice == ALWAYS: persist_allow_entry("WebFetch(" + host + ")")
              if choice in (ONCE, ALWAYS): reply_approved(query.id)
              else:                        reply_rejected(query.id, "User Rejected")
          else:
              reply_rejected(query.id, "Domain not in allowlist")

      # --- any other interaction query: never leave it unanswered ---
      case interaction_query:
          reply_rejected_for_that_query_type(query.id, "Not supported by this client")

      # --- display (§14) ---
      case interaction_update where update.tool_call_completed as t
                               and t.toolCall.tool is web_fetch_tool_call as w:
          match w.result.result:
              case success:  render_markdown(w.result.success.markdown)
              case error:    render_error(w.result.error.error)
              case rejected: render_note(w.result.rejected.reason)

      case interaction_update where update.text_delta as d:
          append_output(d.text)

      case interaction_update where update.turn_ended:
          break

      # --- anything else on the exec channel that you do not implement ---
      case exec_server_message:
          send(stream, { exec_client_control_message: { throw: { id: exec.id,
                          error: "Tool not implemented by this client" } } })
```

The two `reply_*` helpers:

```
reply_approved(id)         → interaction_response { id, webFetchRequestResponse: { approved: {} } }
reply_rejected(id, reason) → interaction_response { id, webFetchRequestResponse: { rejected: { reason } } }
```

A client that wants no fetching at all should instead send
`x-cursor-agent-exclude-tools: web_fetch_tool_call` (§13.1) and delete both fetch branches.

---

## 19. Open questions

1. **Does the precheck actually drive `skip_approval`?** The causal link between answering
   `allowlisted = true` and receiving `skip_approval = true` is inferred from the shape of the two
   messages, not observed. Probe by allowlisting a host and watching the subsequent query.
2. **What does `WebFetchSuccess.output_location` point at for a server-executed tool?** The client
   never reads it. It may reference a server-side artifact or a path the server expects the client to
   have materialised.
3. **Server-side fetch limits.** Timeout, maximum page size, redirect policy, and Markdown
   conversion rules are entirely opaque. `RunWebFetchError.is_timeout` proves at least a timeout
   exists on the direct RPC.
4. **Can a `preToolUse` hook block a server-executed fetch?** See §13.3.
5. **Does the backend enforce anything from the allowlist?** The precheck result is advisory as far
   as the client can tell. Nothing prevents the server from fetching a host the client called
   non-allowlisted, once approval is granted.
6. **JSON mode against the agent endpoint.** Unproven for the whole agent path, fetch included
   (§3.2).

---

## 20. Constants quick reference

| Constant | Value |
| --- | --- |
| Allow/deny entry grammar | `WebFetch(<host-pattern>)`, regex `/^\s*WebFetch\s*\((.*)\)\s*$/`, inner value trimmed |
| Pattern forms | `*` · `*.suffix` (includes the apex) · `a.b.c.d/len` CIDR (v4 and v6) · exact host |
| Scheme assumed for scheme-less input | `https://` (lenient path only) |
| `InteractionQuery` / `InteractionResponse` field | 9 |
| `ToolCall` oneof field | 37, `web_fetch_tool_call` |
| `ExecServerMessage` / `ExecClientMessage` field | 43 |
| Tool-gating header names | `x-cursor-agent-allowed-tools`, `x-cursor-agent-exclude-tools` |
| Tool-gating value for this tool | `web_fetch_tool_call` |
| Direct RPC | `aiserver.v1.AiService/RunWebFetch` |
| Config file | `{CURSOR_CONFIG_DIR ?? $XDG_CONFIG_HOME/cursor ?? ~/.cursor}/cli-config.json` |
| Kill-switch env vars | `CURSOR_FORCED_SHELL_EGRESS`, `CURSOR_FORCED_SHELL_EGRESS_ALLOW_WEB_TOOLS` |
| Falsy env values | `""`, `"0"`, `"false"`, `"off"` (trimmed, lowercased) |
| Approval modes | `allowlist` (default) · `unrestricted` · `auto-review` |
| Heartbeat / stall detector | 5000 ms fixed interval · 30 000 ms no-inbound threshold |
| Auth poll | 150 attempts, `min(1000 × 1.2^n, 10000)` ms, 3 consecutive failures |
| JWT refresh margin | 300 s |
