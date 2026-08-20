# Cursor agent backend protocol

A client that follows this document can authenticate a user, open an authenticated transport to
the Cursor backend, list the models that account may use, run one conversation turn, and consume
the stream.

I derived this by black-box reading of an unpacked official CLI, build `2026.08.11-e8db854`. None
of it is copied source. Field numbers and names come from protobuf descriptor metadata, which is
public wire-format information. Everything else is protocol facts, schemas, and pseudocode.

`[CONFIRMED]` means I saw it directly. `[INFERRED]` means I deduced it with high confidence.
`[UNVERIFIED]` means you still need a live probe.

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [Endpoints and environments](#2-endpoints-and-environments)
3. [Wire protocol](#3-wire-protocol)
4. [Request headers](#4-request-headers)
5. [Authentication](#5-authentication)
6. [Credential storage](#6-credential-storage)
7. [Bootstrap sequence](#7-bootstrap-sequence)
8. [Transport selection](#8-transport-selection)
9. [Service catalogue](#9-service-catalogue)
10. [Model discovery](#10-model-discovery)
11. [Running a conversation](#11-running-a-conversation)
12. [Tool execution round trips](#12-tool-execution-round-trips)
13. [Reliability: heartbeats, checkpoints, resume](#13-reliability-heartbeats-checkpoints-resume)
14. [Error handling](#14-error-handling)
15. [Environment variables](#15-environment-variables)
16. [Minimum viable client](#16-minimum-viable-client)
17. [Open questions](#17-open-questions)

---

## 1. Architecture overview

The backend is a ConnectRPC API using protobuf message types. ConnectRPC is a gRPC-compatible
protocol family that also defines a plain-HTTP JSON mode. The reference client uses that JSON mode
on its fallback path, so you can implement the protocol with an HTTP client and a protobuf JSON
codec.

There are three hosts:

| Role | Purpose |
| --- | --- |
| API host | Auth REST endpoints, `AiService`, `DashboardService`, `ServerConfigService`, `RepositoryService`, `AnalyticsService`, `AutomationsService`, `BackgroundComposerService`. |
| Agent host | `agent.v1.AgentService`, plus `aiserver.v1.BidiService` for the HTTP/1.1 upstream shim (§8.4). Usually the same origin as the API host, but the server can redirect the client to a dedicated host at runtime (§8). |
| Metrics host | Telemetry sink. Not required for a functional client. |

Two protobuf packages matter:

- `aiserver.v1`: account, billing, model catalogue, server configuration, codebase indexing.
- `agent.v1`: the conversation protocol. Run requests, streamed updates, tool execution.

A conversation turn is one long-lived bidirectional stream on `agent.v1.AgentService/Run`. The
client sends a run request and keeps the stream open so it can answer tool-execution requests the
server pushes down. The server streams text deltas, reasoning, tool calls, and token counts until
the turn ends.

---

## 2. Endpoints and environments

### 2.1 Environment table `[CONFIRMED]`

| Environment | API URL | Website URL | Metrics URL |
| --- | --- | --- | --- |
| `prod` (default) | `https://api2.cursor.sh` | `https://cursor.com` | `https://api3.cursor.sh` |
| `playground` | `https://api.playground.cursor.sh` | `https://playground.cursor.com` | none |
| `staging` | `https://staging.cursor.sh` | `https://staging.cursor.sh` | none |
| `dev-staging` | `https://dev-staging.cursor.sh` | `https://dev-staging.cursor.sh` | none |
| `localhost` | `https://localhost:8000` | `https://localhost:8000` | none |

### 2.2 Resolution rules `[CONFIRMED]`

1. The API URL is the explicit override, else `CURSOR_API_ENDPOINT`, else the `prod` API URL.
   A second, independently-read variable `CURSOR_API_BASE_URL` is consulted by the authentication
   module specifically; a complete implementation should honour both, preferring an explicit
   argument over either.
2. The website URL is the explicit override, else `CURSOR_WEBSITE_URL`, else derived.
3. Normalise a candidate URL by lowercasing its origin (scheme + host + port). If the
   normalised origin matches the API *or* website origin of any row in the table, the whole row is
   adopted. Pointing at `https://cursor.com` also selects `https://api2.cursor.sh`.
4. Reject any URL carrying a fragment, query string, username, or password during matching, and
   hard-fail with an error if a user-supplied API or website URL contains `#`.
5. If nothing matches, use the supplied API URL as-is and derive the website URL from its origin.
6. Trailing slashes are stripped from configured base URLs before use.

### 2.3 Auth REST endpoints (not ConnectRPC) `[CONFIRMED]`

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `{apiUrl}/auth/poll?uuid={uuid}&verifier={verifier}` | Poll for completion of a browser login. |
| `POST` | `{apiUrl}/auth/exchange_user_api_key` | Exchange a long-lived API key for a token pair. |
| `GET` | `{websiteUrl}/loginDeepControl?challenge=…&uuid=…&mode=login&redirectTarget=…` | Browser-facing authorization page. |

---

## 3. Wire protocol

### 3.1 URL layout `[CONFIRMED]`

Every RPC is an HTTP `POST` to:

```
{baseUrl}/{fully.qualified.ServiceName}/{MethodName}
```

The service name is the protobuf `typeName` (e.g. `agent.v1.AgentService`) and the method name is
the protobuf method name in `PascalCase` (e.g. `Run`, `GetUsableModels`). Example:

```
POST https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels
```

### 3.2 Unary calls, JSON mode `[CONFIRMED]`

- Request header `Content-Type: application/json`.
- Request body: the protobuf message serialised with protobuf JSON mapping.
  `lowerCamelCase` field names, enums as their string names, `bytes` as standard base64, 64-bit
  integers as strings.
- On `2xx`: body is the response message in protobuf JSON. Decode with unknown fields ignored;
  the server adds fields ahead of clients.
- On non-`2xx`: body is a Connect error object. Map the HTTP status to a Connect code and, when the
  body parses as JSON, prefer the `code` and `message` it carries. Truncate unparseable bodies for
  display (the reference client caps at 512 characters).

### 3.3 Streaming calls, `connect+json` framing `[CONFIRMED]`

- Request header `Content-Type: application/connect+json`.
- Both directions are a sequence of enveloped frames:

```
byte  0      : flags
bytes 1..4   : payload length, uint32, big-endian
bytes 5..5+n : payload
```

- `flags == 0x00` → payload is one protobuf-JSON-encoded message of the stream's message type.
- `flags & 0x02` → end-of-stream frame. Its payload is a JSON object. If it contains an
  `error` member, the stream failed. Surface `error.message` and `error.code`. Otherwise the stream
  completed normally. Nothing follows this frame.
- Other flag bits (notably `0x01`, compression) exist in the Connect specification. The reference
  fallback path emits `0x00` only and treats any frame with `0x02` as terminal.

Framing pseudocode:

```
function encode_frame(json_bytes):
    out = byte_buffer(5 + len(json_bytes))
    out[0] = 0x00
    write_uint32_be(out, offset=1, value=len(json_bytes))
    copy(json_bytes -> out[5:])
    return out

function decode_frames(byte_stream):
    buf = empty
    for chunk in byte_stream:
        buf += chunk
        while len(buf) >= 5:
            flags  = buf[0]
            length = read_uint32_be(buf, 1)
            if len(buf) < 5 + length: break
            payload = buf[5 : 5+length]
            buf = buf[5+length :]
            if flags & 0x02:
                trailer = json_parse(payload)
                if trailer.error: raise StreamError(trailer.error.message, trailer.error.code)
                return                      # normal completion
            yield decode_message(json_parse(payload))
```

### 3.4 Binary mode `[INFERRED]`

The primary (non-fallback) transport uses connect-node with protobuf binary encoding and
`gzip` request compression, over HTTP/1.1 or HTTP/2 (§8).

Read this before you commit to JSON. The JSON mode above is protocol-equivalent by specification,
and it is the cheapest target for a clean-room client. It is not the mode the reference client uses
against the endpoints this document cares about. The hand-rolled JSON transport is instantiated
exactly twice in the distribution, for `AnalyticsService` and `BackgroundComposerService`.
`AiService`, `ServerConfigService`, `AutomationsService`, and the entire agent path all use
connect-node with binary encoding. `[CONFIRMED]`

I never saw the model, config, or agent endpoints accept JSON. The Connect spec says they should.
Before building on §16, run one authenticated JSON call against the config endpoint and one
`application/connect+json` stream against `AgentService/Run`. If either is rejected, you need binary
Connect encoding. The field tables here stay correct. Only the framing changes. See §17 item 3.

### 3.5 Compression `[CONFIRMED]`

The reference client advertises and uses gzip for request bodies on connect-node transports.
Brotli is available in the library but not selected. Compression is optional for a new client.

---

## 4. Request headers

An interceptor stamps the following on every RPC across all transports.

| Header | Value | Notes |
| --- | --- | --- |
| `authorization` | `Bearer {accessToken}` | Omitted when no token is available. §5. |
| `x-ghost-mode` | `"true"` / `"false"` | Privacy flag. Fails closed to `"true"` if the cached privacy value is missing, non-boolean, or reading it throws. §7.2. |
| `x-request-id` | UUID v4 | Fresh per request unless the caller pre-set one. Regenerated on every retry attempt. Also the bidi correlation key (§8.4). |
| `x-original-request-id` | UUID v4 | Stable across all retries of one logical run. Set on `Run`. |
| `x-cursor-client-version` | `cli-{version}` or `cli-{version}-{channel}` | Channel suffix is appended only when the channel is neither `prod` nor `prod-stable-internal`. The version string is baked in at build time. |
| `x-cursor-client-type` | client identifier | Default `cli`. Other observed values: `interactive`, `acp`, `cloud`, `private_worker`, `extension`. |
| `x-cursor-streaming` | `"true"` | Only on the HTTP/1.1 agent transport (§8). |
| `x-cursor-mdm-signin-policy` | `v1.{base64url(json)}` | Only when a managed-device policy is active. §5.5. |
| `local-cli-mode` | `"true"` | Only when `CURSOR_AGENT_CLI_LOCAL_MODE=true`. |
| `x-dev-experiment-overrides` | opaque | Development only. |

Additional headers seen on adjacent surfaces, not required for the core flow:
`x-cursor-host-app-name`, `x-cursor-host-app-version`, `x-inference-authentication-jwt`,
`x-parent-request-id`, `x-root-parent-request-id`, `x-cursor-checksum` (cloud-worker bridge only),
`x-worker-*` and `x-repository-url*` (cloud-worker registration only).

The CLI does not send a `x-cursor-checksum` on the main API or agent transports. A new
client does not need to synthesise one.

Response headers worth reading: `x-cursor-inference-request-error-type` carries a machine-readable
inference failure category.

---

## 5. Authentication

Three mutually exclusive credential sources exist. Precedence, highest first `[CONFIRMED]`:

1. Raw auth token. `--auth-token` flag or `CURSOR_AUTH_TOKEN`. Used verbatim as both access
   and refresh token. No exchange happens.
2. API key. `--api-key` flag or `CURSOR_API_KEY`. Exchanged for a token pair (§5.2).
3. Interactive browser login (§5.1).

If none succeed, the client must fail with an authentication-required error.

### 5.1 Browser login (challenge/poll) `[CONFIRMED]`

This looks like OAuth 2.0 PKCE with a device-flow-style poll. It is not RFC-compliant OAuth.
There is no `client_id`, no `/token` endpoint, no `grant_type`, and the poll returns the token pair
directly as JSON.

Generate the challenge.

```
verifier  = base64url_nopad(random_bytes(32))
challenge = base64url_nopad(sha256(utf8_bytes(verifier)))
uuid      = uuid_v4()
```

`base64url_nopad` means standard base64 with `+`→`-`, `/`→`_`, and all `=` padding removed.
The SHA-256 is computed over the ASCII characters of the base64url verifier string, not over the
raw 32 random bytes. Hash the string, not the bytes. I got this wrong the first time I read it.

Build the authorization URL.

```
{websiteUrl}/loginDeepControl
    ?challenge={challenge}
    &uuid={uuid}
    &mode=login
    &redirectTarget={redirectTarget}
```

`redirectTarget` defaults to `cli`. Open this in the user's browser. Also render it as text and,
optionally, as a QR code for sign-in from a second device. No local callback listener is involved.
The browser never redirects back to the client.

Poll.

```
GET {apiUrl}/auth/poll?uuid={uuid}&verifier={verifier}
Content-Type: application/json
[+ x-cursor-mdm-signin-policy when applicable]
```

Polling parameters `[CONFIRMED]`:

| Parameter | Value |
| --- | --- |
| Maximum attempts | 150 |
| Base delay | 1000 ms |
| Backoff | `min(1000 × 1.2^attempt, 10000)` ms, exponential, capped at 10 s |
| Jitter | none |
| Consecutive-failure budget | 3 (then give up, returning "not authenticated") |

Response handling:

- `404` → not yet authorized. Reset the consecutive-failure counter, sleep the backoff, retry.
  This is the normal "still waiting" signal.
- `403` with a JSON body whose `error` equals `sign_in_policy_violation` → abort immediately
  with a device-policy error. Do not retry.
- `2xx` with a JSON body containing both `accessToken` and `refreshToken` → success.
- Any other non-`2xx`, or a transport error → increment the consecutive-failure counter; give up at
  3, otherwise back off and retry.
- Honour an abort signal at the top of every iteration.

Success payload shape `[CONFIRMED]`:

```json
{ "accessToken": "<JWT>", "refreshToken": "<token>" }
```

Additional members may be present and should be ignored. The client validates only that both keys
exist.

Persist the pair (§6), clear any cached privacy value, then run the bootstrap sequence (§7).

### 5.2 API key exchange `[CONFIRMED]`

```
POST {apiUrl}/auth/exchange_user_api_key
Content-Type: application/json
Authorization: Bearer {apiKey}
[+ x-cursor-mdm-signin-policy when applicable]

{}
```

The body is an empty JSON object; the key travels in the `Authorization` header.

| Response | Meaning |
| --- | --- |
| `2xx` with `{accessToken, refreshToken}` | Success. |
| `403` with `error == "sign_in_policy_violation"` | Device policy rejection. Fatal. |
| Other `403` | Invalid key. Return "not authenticated". |
| `>= 500` | Network or server error. Surface as a retryable network failure. |
| Other non-`2xx` | Invalid key. |

On success, persist `(accessToken, refreshToken, apiKey)` together so the key can drive silent
re-exchange later (§5.4).

### 5.3 Raw auth token `[CONFIRMED]`

If a raw token is supplied, store it as both the access token and the refresh token and skip all
exchange. There is no way to refresh such a credential; when it expires the user must supply a new
one.

### 5.4 Token lifetime and refresh `[CONFIRMED]`

The access token is a JWT. Expiry is evaluated locally:

```
function is_expiring_soon(jwt):
    try:
        payload = json_parse(base64_decode(jwt.split(".")[1]))
        return (payload.exp - now_unix_seconds()) < 300     # 300 s safety margin
    except:
        return true                                          # unparseable ⇒ treat as expired
```

The token selection routine, run before every request:

```
function current_token(store):
    token     = store.access_token
    ephemeral = in_memory_freshly_refreshed_token          # process-local, not persisted

    if token is null:
        if ephemeral is not null:
            return ephemeral if not is_expiring_soon(ephemeral) else (refresh() ?? ephemeral)
        return refresh()

    if not is_expiring_soon(token):
        return token

    refreshed = refresh()
    if refreshed: return refreshed
    if ephemeral and not is_expiring_soon(ephemeral): return ephemeral
    return token                                            # last resort: send the stale token
```

`refresh()` in the reference client is only "re-run the API-key exchange" (§5.2). It needs an API
key from the credential store, an in-memory override, or `CURSOR_API_KEY`. A session established
purely by browser login has no working refresh path in this client. The stored `refreshToken` is
persisted but never redeemed by any endpoint I saw. `[CONFIRMED]` that no refresh endpoint is
called. `[UNVERIFIED]` whether the server exposes one.

If you want a long-lived session, use an API key. Otherwise plan to re-run the browser flow when
the JWT expires. This is the kind of gap that will bite you at 3am.

The freshly-obtained access token is also written to a process-local "ephemeral token" slot so that
concurrent in-flight requests pick it up without re-reading persistent storage.

### 5.5 Managed-device sign-in policy `[CONFIRMED]`

On macOS the client reads managed-preference plists for bundle identifiers
`com.todesktop.230313mzl4w4u92` and `co.anysphere.cursor.dev`, from both
`/Library/Managed Preferences/{user}/{bundleId}.plist` and
`/Library/Managed Preferences/{bundleId}.plist`, converting them to JSON. An override is also read
from `CURSOR_MDM_SIGN_IN_POLICY_JSON`. The result is cached for 30 seconds.

Recognised keys: `SignInEnforcement`, `AllowedOrganizationIds`, `AllowedTeamIds`, `AllowedTeamId`,
`AllowedLoginEmails`, `AllowedLoginDomains`. Comma-separated lists are split and trimmed. Truthy
values for `SignInEnforcement` are boolean `true`, numeric `1`, or the strings `1/true/yes/on`
(case-insensitive, trimmed). Emails are lowercased and must contain `@`; domains are lowercased with
a leading `@` stripped and must contain neither `@` nor whitespace.

If any constraint is present, the header is:

```
x-cursor-mdm-signin-policy: v1.{base64url(json)}
```

where the JSON is exactly:

```json
{ "enforced": <bool>,
  "allowedOrganizationIds": [<decimal strings>],
  "allowedTeamIds": [<decimal strings>],
  "allowedLoginEmails": [<lowercased>],
  "allowedLoginDomains": [<lowercased>] }
```

A client on a non-managed machine simply omits the header. This is a client-asserted header, so
a clean-room implementation may ignore the mechanism entirely. The server's `403` /
`sign_in_policy_violation` response must still be handled.

### 5.6 Proxy support `[CONFIRMED]`

Auth HTTP calls honour `HTTPS_PROXY` / `https_proxy`. On network failure the error message should
name the proxy with credentials stripped from the URL, or advise setting `HTTPS_PROXY` when none is
configured.

---

## 6. Credential storage

Three interchangeable backends, selected by `AGENT_CLI_CREDENTIAL_STORE` `[CONFIRMED]`:

| Value | Backend |
| --- | --- |
| `memory` | Process-local only. |
| `file` | JSON file on disk. |
| unset / `default` | OS keychain on macOS; file elsewhere. |

### 6.1 File backend `[CONFIRMED]`

Path, given a domain string (the CLI uses its own name):

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\{Domain}\auth.json`. Domain in Title Case. `%APPDATA%` defaults to `~/AppData/Roaming` |
| macOS | `~/.{domain}/auth.json` |
| Other | `${XDG_CONFIG_HOME:-~/.config}/{domain}/auth.json` |

Permissions: directory `0700`, file `0600`, both enforced on every write. Content:

```json
{ "accessToken": "…", "refreshToken": "…", "apiKey": "…",
  "bedrockCredentials": { "accessKey": "…", "secretKey": "…", "sessionToken": "…" } }
```

Clearing authentication deletes the file unless Bedrock credentials are present, in which case the
file is rewritten with only that member.

### 6.2 Keychain backend (macOS) `[CONFIRMED]`

One account, several services, all derived from the trimmed domain:

| Item | Service name |
| --- | --- |
| account (shared) | `{domain}-user` |
| access token | `{domain}-access-token` |
| refresh token | `{domain}-refresh-token` |
| API key | `{domain}-api-key` |
| Bedrock access key | `{domain}-bedrock-access-key` |
| Bedrock secret key | `{domain}-bedrock-secret-key` |
| Bedrock session token | `{domain}-bedrock-session-token` |

A "keychain unavailable" error is treated as "secret absent" on read and swallowed on delete.

### 6.3 Keychain avoidance heuristic `[CONFIRMED]`

The keychain is a bad default when all of these hold: platform is macOS, the session looks like
SSH, the process is not in CI, and the store kind is `default`. In that case prompt for or fall back
to the file store. Keychain access over SSH pops a GUI prompt nobody can answer.

### 6.4 Configuration directories `[CONFIRMED]`

| Purpose | Resolution |
| --- | --- |
| Config dir | `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor` |
| Data dir | `CURSOR_DATA_DIR`, else `~/.cursor` |
| Per-project dir | `{dataDir}/projects/{slug(workspacePath)}` |

Project paths are length-capped: if the projects root exceeds 84 characters it falls back to the
data dir, then to `/tmp/.cursor`; if the final path exceeds 92 characters, it is truncated to 84 and
suffixed with `-{first 7 hex chars of sha256(fullPath)}`. This exists to stay under UNIX domain
socket path limits.

---

## 7. Bootstrap sequence

After authentication, before the first conversation:

```
1. GetServerConfig            → transport selection + feature flags   (§7.1)
2. GetUserPrivacyMode         → x-ghost-mode value                     (§7.2)
3. GetMe                      → identity, team, cache keying           (§7.3)
4. AvailableModels / GetUsableModels / GetDefaultModelForCli  (§10)
```

Step 1 is always on the critical path. Step 2 joins it whenever the server supplies an
`agent_url_config`, because ghost mode selects between the two agent hosts (§8.2). Resolve privacy
before you pick the host, or you will talk to the wrong one. Steps 3 and 4 can be lazy.

### 7.1 `aiserver.v1.ServerConfigService/GetServerConfig` `[CONFIRMED]`

Unary. Request `aiserver.v1.GetServerConfigRequest`. Response
`aiserver.v1.GetServerConfigResponse`, of which the fields relevant to a minimal client are:

| # | Field | Type | Use |
| --- | --- | --- | --- |
| 2 | `is_dev_do_not_use_for_secret_things_because_can_be_spoofed_by_users` | bool | dev detection |
| 3 | `indexing_config` | message | codebase indexing keys |
| 6 | `config_version` | string | |
| 7 | `http2_config` | enum `aiserver.v1.Http2Config` | transport selection, §8 |
| 12 | `model_migrations` | repeated message | model id remapping |
| 23 | `client_version_status` | message | update nagging |

The response also carries `bug_config_response`, `client_tracing_config`, `chat_config`,
`profiling_config`, `metrics_config`, `background_composer_config`, `auto_context_config`,
`memory_monitor_config`, `folder_size_limit`, `git_indexing_config`, `performance_events_config`,
`current_in_app_ad`, `trace_config`, `run_terminal_server_config`, `online_metrics_config`,
`interaction_config`, `agent_telemetry_config`. An `agent_url_config` member of type
`aiserver.v1.AgentUrlConfig` supplies the dedicated agent hosts:

```proto
message AgentUrlConfig {
  string agent_url  = 1;   // used when ghost mode is ON
  string agentn_url = 2;   // used when ghost mode is OFF
}
```

```proto
enum Http2Config {
  HTTP2_CONFIG_UNSPECIFIED        = 0;
  HTTP2_CONFIG_FORCE_ALL_DISABLED = 1;
  HTTP2_CONFIG_FORCE_ALL_ENABLED  = 2;
  HTTP2_CONFIG_FORCE_BIDI_DISABLED= 3;
  HTTP2_CONFIG_FORCE_BIDI_ENABLED = 4;
}
```

The reference client caches the derived values keyed by `(backendUrl, authCacheKey, teamId)`
where `authCacheKey` is `auth:{authId}`, else `user:{userId}`, else `email:{email}`. On startup it
serves the cache and refreshes in the background. Agent-client construction waits up to 5000 ms
for the refresh before falling back to cached values. A cache entry with an unknown `http2_config`
counts as a miss. Both agent URLs must parse as valid URLs or the whole `agent_url_config` is
discarded.

### 7.2 `aiserver.v1.DashboardService/GetUserPrivacyMode` `[CONFIRMED]`

```proto
message GetUserPrivacyModeRequest {
  PrivacyMode inferred_privacy_mode = 1;   // client sends UNSPECIFIED (0)
  optional int32 team_id            = 2;
}
message GetUserPrivacyModeResponse {
  PrivacyMode privacy_mode                        = 1;
  int32       hours_remaining_in_grace_period     = 2;
  bool        is_enforced_by_team                 = 3;
  bool        is_not_migrated_to_server_source_of_truth = 4;
  bool        partner_data_share                  = 5;
  // + has_acknowledged_grace_period_disclaimer
}
enum PrivacyMode {
  PRIVACY_MODE_UNSPECIFIED                     = 0;
  PRIVACY_MODE_NO_STORAGE                      = 1;
  PRIVACY_MODE_NO_TRAINING                     = 2;
  PRIVACY_MODE_USAGE_DATA_TRAINING_ALLOWED     = 3;
  PRIVACY_MODE_USAGE_CODEBASE_TRAINING_ALLOWED = 4;
}
```

Ghost mode is `privacy_mode ∈ {0, 1, 2}`. That is `true` unless the user has explicitly opted into
training. `[CONFIRMED]`

Cached for `CURSOR_PRIVACY_CACHE_MAX_AGE_MS` (default 3 600 000 ms), plus an opportunistic refresh
with probability `1 / CURSOR_PRIVACY_SAMPLE_RATE` (default 10) on any request. The refresh runs
fire-and-forget on a separate HTTP/1.1 transport and never blocks the request that triggered it.
Failures are swallowed. The header falls back to `"true"`.

The privacy probe rewrites any base URL ending in `cursor.sh` to `https://api2.cursor.sh` before
calling. Reproduce that. I do not know why it exists, but the reference client does it.

### 7.3 `aiserver.v1.DashboardService/GetMe` `[CONFIRMED]`

Request is empty. Response:

| # | Field | Type |
| --- | --- | --- |
| 1 | `auth_id` | string |
| 2 | `user_id` | int32 |
| 3 | `email` | optional string |
| 4 | `first_name` | optional string |
| 5 | `last_name` | optional string |
| 6 | `workos_id` | optional string |
| 7 | `team_id` | optional int32 |
| 8 | `created_at` | optional string |
| 9 | `is_enterprise_user` | optional bool |
| 10 | `team_name` | optional string |

An empty-string `auth_id` means "absent" and should be normalised to null.

---

## 8. Transport selection

The API host always uses HTTP/1.1. The agent host negotiates. `[CONFIRMED]`

### 8.1 Decision table

Inputs: `localPrefersHttp1` (user setting, default `false`) and `serverHttp2Config` from §7.1.

| `serverHttp2Config` | Result | Reason tag |
| --- | --- | --- |
| `FORCE_ALL_DISABLED` (1) | HTTP/1.1 | `server_force_all_disabled` |
| `FORCE_BIDI_DISABLED` (3) | HTTP/1.1 | `server_force_bidi_disabled` |
| `FORCE_ALL_ENABLED` (2) | HTTP/2 | `server_force_all_enabled` |
| `FORCE_BIDI_ENABLED` (4) | HTTP/2 | `server_force_bidi_enabled` |
| `UNSPECIFIED` (0) or unknown | follow `localPrefersHttp1` | `local_config_http1` / `default_http2` |

HTTP/2 is the default.

### 8.2 Agent host selection `[CONFIRMED]`

```
function agent_base_url(backendUrl, ghostMode, agentUrlConfig, usingHttp1):
    if backendUrl contains any of ["localhost", "lclhst.build",
                                   "staging.cursor.sh", "dev-staging.cursor.sh"]:
        return backendUrl
    if usingHttp1:
        return backendUrl                      # the dedicated hosts are HTTP/2-only
    if agentUrlConfig has both agent_url and agentn_url:
        return ghostMode ? agentUrlConfig.agent_url : agentUrlConfig.agentn_url
    return backendUrl
```

An explicit agent-endpoint override, if supplied, wins over all of this.

### 8.3 HTTP/2 mode `[CONFIRMED]`

- A pool of independent HTTP/2 sessions, default size 4, overridable by a server-side
  feature flag named `http2_agent_connection_pool_config` with key `poolSize`. Non-numeric,
  non-finite, or non-positive values fall back to 4. Otherwise `max(1, floor(value))`.
- Requests are dispatched round-robin across the pool.
- Keepalive pings: interval 10 000 ms, timeout 20 000 ms, pings sent even on idle
  connections.
- Proxy: for an `https:` agent origin, the first non-empty of `HTTPS_PROXY`, `https_proxy`,
  `HTTP_PROXY`, `http_proxy`; for `http:`, the first non-empty of `HTTP_PROXY`, `http_proxy`.
  When a proxy is configured, the pool is built from proxy-aware sessions instead.
- `autoSelectFamilyAttemptTimeout` is 1000 ms (Happy Eyeballs dual-stack racing).
- TLS verification is on unless an explicit insecure flag is set.

### 8.4 HTTP/1.1 mode and the bidi shim `[CONFIRMED]`

HTTP/1.1 cannot carry a true bidirectional stream, so bidi RPCs are emulated:

- The transport adds `x-cursor-streaming: true`.
- A shim intercepts calls whose kind is bidi-streaming and rewrites
  `agent.v1.AgentService/Run` into `agent.v1.AgentService/RunSSE`, a server-streaming method.
  Unary and server-streaming calls pass through untouched. The shim throws on any method other than
  `Run`.

The shim reads `x-request-id` from the outgoing headers. If absent it generates a UUID v4 and
injects it. That string binds both halves.

`RunSSE` takes a single `aiserver.v1.BidiRequestId { string request_id = 1; }` and returns a stream
of the same `agent.v1.AgentServerMessage` type as `Run`. No re-framing, no sequence numbers. Server
frames arrive as ordinary typed Connect stream messages.

Each outbound `AgentClientMessage` becomes a discrete unary call to
`aiserver.v1.BidiService/BidiAppend`:

```proto
message BidiAppendRequest {
  string        data          = 1;  // lowercase hex of the serialized frame (TEXT mode, default)
  BidiRequestId request_id    = 2;
  int64         append_seqno  = 3;  // counter from 0, +1 per message
  bytes         data_binary   = 4;  // raw serialized frame (BINARY mode, opt-in)
}
message BidiAppendResponse {}       // empty
```

- Hex text mode is the default. Binary is opt-in.
- Appends are issued concurrently, up to 16 in flight. At 16 the pump awaits the first to
  settle. Arrival order is not the contract. The server reassembles by `append_seqno`.
- Per-append deadline: `appendTimeoutMs + ceil(payloadBytes / 131072 × 1000)` ms, where
  `appendTimeoutMs` defaults to 60 000 and `payloadBytes` is the serialized length (doubled in
  hex mode). A shorter caller-supplied timeout wins. Exceeding it produces Connect code
  `DeadlineExceeded` with message
  `bidi_append_deadline_exceeded: append seqno=<n> (<bytes> bytes) exceeded <ms>ms deadline`.
- The first append error aborts the pump, cancels outstanding appends, and is injected into the
  downstream iterator so an upstream failure surfaces as a response-stream error rather than
  being swallowed.
- End of stream is signalled by the outbound iterator completing; the shim then waits for all
  outstanding appends to settle.

`RunPoll` is the alternative downstream for environments that cannot hold a long-lived server
stream:

```proto
message BidiPollRequest  { BidiRequestId request_id = 1; optional bool start_request = 2; }
message BidiPollResponse { int64 seqno = 1; string data = 2; optional bool eof = 3; }
```

Repeated polls resume from the last `seqno`; `start_request` tells the server whether this poll
should also kick off the run. The reference client never uses it. `[CONFIRMED]` schema,
`[UNVERIFIED]` server behaviour.

For a clean-room implementation, prefer HTTP/2 and true bidi; implement the shim only if you must
traverse an HTTP/1.1-only proxy.

---

## 9. Service catalogue

| Service | Host | Role |
| --- | --- | --- |
| `agent.v1.AgentService` | agent | Conversations, model lists, transcripts. |
| `aiserver.v1.AiService` | API | Large general API, about 596 methods, including the model catalogue. |
| `aiserver.v1.DashboardService` | API | Account, team, usage, privacy. |
| `aiserver.v1.ServerConfigService` | API | `GetServerConfig`. |
| `aiserver.v1.RepositoryService` | API | Codebase indexing and semantic search. |
| `aiserver.v1.AnalyticsService` | API | `TrackEvents`, `Batch`, `BootstrapStatsig`. |
| `aiserver.v1.AutomationsService` | API | Automations, SCM integrations. |
| `aiserver.v1.BidiService` | agent | `BidiAppend`. HTTP/1.1 upstream shim only. |
| `aiserver.v1.BackgroundComposerService` | API | Background composer; lazily loaded. |

### 9.1 `agent.v1.AgentService` methods `[CONFIRMED]`

| Method | Kind | Request → Response |
| --- | --- | --- |
| `Run` | bidi stream | `AgentClientMessage` → `AgentServerMessage` |
| `RunSSE` | server stream | *(bidi envelope)* → `AgentServerMessage` |
| `RunPoll` | server stream | *(poll envelope)* → *(poll response)* |
| `NameAgent` | unary | `NameAgentRequest` → `NameAgentResponse` |
| `UpdateConversationMetadata` | unary | … |
| `CreateTranscriptOverview` | unary | … |
| `GetUsableModels` | unary | `GetUsableModelsRequest` → `GetUsableModelsResponse` |
| `GetDefaultModelForCli` | unary | `GetDefaultModelForCliRequest` → `GetDefaultModelForCliResponse` |
| `GetAllowedModelIntents` | unary | … |
| `UploadConversationBlobs` | unary | … |
| `UploadLocalAgentRunToPromptQuality` | unary | … |
| `GetSignedUrlForAttachedMedia` | unary | … |
| `NotifyConversationClone` | unary | … |
| `GetNewChatNudgeLegacyModelPicker` | unary | … |
| `GetNewChatNudgeParameterizedModelPicker` | unary | … |
| `GetPromptContextUsage` | unary | … |

`GetUsableModels` and `GetDefaultModelForCli` are also exposed on `aiserver.v1.AiService`, and
that is where the reference model-listing code actually calls them. `AvailableModels` exists only
on `aiserver.v1.AiService`. `[CONFIRMED]`

### 9.2 Selected `aiserver.v1.DashboardService` methods

`GetMe`, `GetUserPrivacyMode`, `GetTeams`, `GetHardLimit`, `GetMonthlyInvoice`,
`GetFilteredUsageEvents`, `GetAggregatedUsageEvents`, `GetUsageBasedPremiumRequests`,
`GetUsageLimitPolicyStatus`, `GetUsageLimitStatusAndActiveGrants`.

### 9.3 `aiserver.v1.RepositoryService` methods

`EnsureIndexCreated`, `FastRepoInitHandshake`, `FastRepoInitHandshakeV2`, `FastRepoSyncComplete`,
`FastUpdateFile`, `FastUpdateFileV2`, `GetAvailableChunkingStrategies`, `GetCopyStatus`,
`GetEmbeddings`, `GetHighLevelFolderDescription`, `GetLineNumberClassifications`,
`GetNumFilesToSend`, `GetUploadLimits`, `RemoveRepositoryV2`, `SearchRepositoryV2`, `SemSearch`,
`SemSearchFast`, `SyncMerkleSubtree`, `SyncMerkleSubtreeV2`.

---

## 10. Model discovery

Three independent RPCs are issued concurrently, and their results merged. `[CONFIRMED]`

### 10.1 `GetUsableModels`, the authoritative allow-list

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
  oneof credentials {                        // BYOK; omit for first-party use
    ApiKeyCredentials  api_key_credentials  = 8;
    AzureCredentials   azure_credentials    = 9;
    BedrockCredentials bedrock_credentials  = 10;
  }
}

message ApiKeyCredentials { string api_key = 1; optional string base_url = 2; }
```

An empty `models` list is treated as "no data" rather than "no models".

```proto
message AzureCredentials   { string api_key = 1; string base_url = 2; string deployment = 3; }
message BedrockCredentials { string access_key = 1; string secret_key = 2; string region = 3;
                             optional string session_token = 4; }
message ThinkingDetails    {}                               // currently empty
```

There is no unauthenticated model listing. The reference client resolves auth (auth-token → API
key → interactive login) before any of these RPCs and exits with an error if all three fail. It
never falls back to a hardcoded catalogue.

### 10.2 `GetDefaultModelForCli`, the recommended default

```proto
message GetDefaultModelForCliRequest  {}                    // empty
message GetDefaultModelForCliResponse { ModelDetails model = 1; }

message GetAllowedModelIntentsRequest  {}                   // empty
message GetAllowedModelIntentsResponse { repeated string model_intents = 1; }
```

`GetAllowedModelIntents` is declared on `agent.v1.AgentService` but never invoked anywhere in
the distribution. A compatible client does not need it. `[CONFIRMED]`

### 10.3 `AvailableModels`, the rich catalogue

On `aiserver.v1.AiService`. This is where capabilities, context limits, pricing, and parameter
definitions live.

```proto
message AvailableModelsRequest {
  bool            is_nightly                              = 1;
  bool            include_long_context_models             = 2;
  bool            exclude_max_named_models                = 3;
  repeated string additional_model_names                  = 4;
  optional bool   use_model_parameters                    = 5;
  optional bool   include_hidden_models                   = 6;
  optional bool   do_not_use_markdown                     = 7;
  optional bool   variants_will_be_shown_in_exploded_list = 8;
  optional bool   for_automations                         = 9;
  optional Scope  scope                                   = 10;
  optional bool   use_react_model_picker                  = 11;
  optional bool   use_cloud_agent_effort_modes            = 12;
  optional string admin_settings_group_public_id          = 13;
  optional bool   byok_enabled                            = 14;
}
```

The CLI sends `use_model_parameters = true`, `do_not_use_markdown = true`, and
`additional_model_names = custom ids` (usually empty). `[CONFIRMED]`

`AvailableModelsResponse` carries `models` (field 2), legacy `model_names` (field 1), per-feature
default configs (`composer_model_config` 4, `cmd_k_model_config` 5,
`background_composer_model_config` 6, `plan_execution_model_config` 7, `spec_model_config` 8,
`deep_search_model_config` 9, `quick_agent_model_config` 10, `subagent_model_configs` 16),
`use_model_parameters` 11, cache-invalidation hints 12/13, `display_configuration` 15, and
experimental-model hints 19 to 21.

`AvailableModelsResponse.AvailableModel`, the fields an implementer will actually use:

| # | Field | Type | Meaning |
| --- | --- | --- | --- |
| 1 | `name` | string | Canonical model id. |
| 2 | `default_on` | bool | Enabled by default. |
| 5 | `supports_agent` | optional bool | Required for agent conversations. |
| 6 | `degradation_status` | enum | Provider health. |
| 7 | `price` | optional double | |
| 9 | `supports_thinking` | optional bool | Emits `thinking_delta`. |
| 10 | `supports_images` | optional bool | |
| 14 | `supports_max_mode` | optional bool | |
| 15 | `context_token_limit` | optional int32 | |
| 16 | `context_token_limit_for_max_mode` | optional int32 | |
| 17 | `client_display_name` | optional string | |
| 18 | `server_model_name` | optional string | |
| 22 | `supports_plan_mode` | optional bool | |
| 25 | `supports_sandboxing` | optional bool | |
| 29 | `parameter_definitions` | repeated `ModelParameterDefinition` | Parameterised models. |
| 30 | `variants` | repeated `ModelVariantConfig` | Pre-baked parameter combinations. |
| 34 | `upgrade_model_id` | optional string | Migration target. |
| 35 | `is_hidden` | optional bool | |
| 36 | `legacy_slugs` | repeated string | |
| 37 | `id_aliases` | repeated string | |
| 41 | `vendor_name` | optional string | |
| 45 | `supports_smart_mode_classifier` | optional bool | |
| 46 | `requires_data_retention` | optional bool | |
| 47 | `reason_for_zdr_consent_block` | optional string | |
| 48 | `model_picker_badges` | repeated `ModelPickerBadge` | |

Also present: 3 `is_long_context_only`, 4 `is_chat_only`, 8/20 tooltip data, 11 to 13 auto-context,
19 `supports_non_max_mode`, 21 background-composer recommendation, 23 `is_user_added`,
24 `inputbox_short_model_name`, 26/27 Cmd-K support, 28 sort order, 32/44 cloud-agent effort modes,
33 `cloud_migrate_to_model`, 38 section index, 39 `tagline`, 40 routed-model visibility,
42 `vendor`, 43 admin-allowlist default.

Field 7 `price` (double) is the only pricing signal in the protocol, and the reference client
ignores it.

```proto
message ModelParameterDefinition {
  string id                       = 1;
  string name                     = 2;
  optional string markdown_tooltip= 3;
  ModelParameterType parameter_type = 4;
  optional bool is_cycleable_by_hotkey = 5;
}

message ModelVariantConfig {
  repeated RequestedModel.ModelParameterValue parameter_values = 1;
  string display_name                    = 2;
  bool   is_max_mode                     = 3;
  optional bool is_default_max_config    = 4;
  optional bool is_default_non_max_config= 5;
  optional TooltipData tooltip_data      = 6;
  optional string tagline                = 7;
  optional string display_name_outside_picker = 8;
  optional string variant_string_representation = 9;
  optional ConfirmationDialogue confirmation_dialogue = 10;
  optional string legacy_slug            = 11;
}
```

### 10.4 Merge and filter algorithm `[CONFIRMED]`

```
function fetch_models(client, custom_ids = []):
    # all three in flight simultaneously
    usable_f  = client.GetUsableModels({ customModelIds: custom_ids })
    default_f = client.GetDefaultModelForCli({})
    params_f  = client.AvailableModels({ useModelParameters: true,
                                         doNotUseMarkdown: true,
                                         additionalModelNames: custom_ids })

    usable, default = await_all_settled(usable_f, default_f)
    params          = await_with_timeout(params_f, 2000ms)   # soft: timeout ⇒ degrade, not fail

    result = {}
    if usable ok and non-empty : result.availableModels = usable.models
    if usable failed           : result.usableModelsError = error        # fatal
    if default ok              : result.defaultModel = default.model     # soft
    if params ok               : result.parameterizedModels = filter_parameterized(params.models)
    if params timed out        : result.parameterizedModelsFetchStatus = "timed_out"
    return result
```

Only a `GetUsableModels` failure is fatal. The other two degrade silently.

`filter_parameterized` `[CONFIRMED]`:

1. Drop models whose `name` is in the exclusion set
   `{claude-4.5-haiku, claude-4.5-haiku-thinking, gemini-2.5-pro, gemini-2.5-flash}`.
2. Keep the result only if at least one surviving model has a non-empty `parameter_definitions`
   or `variants`. Otherwise treat the parameterised catalogue as absent.

### 10.5 Display, identity, and alias rules `[CONFIRMED]`

- Display id: `display_model_id` if set, else `model_id`, else `""`.
- Display label: `display_name` if set, else `display_name_short`.
- No sorting. Models are shown in the exact order returned by `GetUsableModels`.
- A model is the auto/router entry when `model_id == "default"`, or
  `display_model_id == "auto"`, or `lowercase(display_name) == "auto"`. Auto entries are exempt from
  max-mode coercion and are hoisted to the top of an interactive picker.
- Legacy id remapping applied client-side before anything else: `composer-2` → `composer-2.5`,
  `composer-2-fast` → `composer-2.5-fast`.
- Vendor prefixes `GENERICBASE` and `XAIEXTERNAL` bypass catalogue validation entirely. A
  `ModelDetails` is synthesised with all four string fields set to the raw id.
- Bedrock models are filtered out when the Bedrock profile is disabled. The predicate is
  `lower(model_id).includes("anthropic.claude") || lower(model_id).endsWith("-v1:0")`. If the filter
  would remove nothing, the original list is returned unchanged.

The alias map is rebuilt from `GetUsableModels` after every fetch. Every key is lowercased, and
all of the following map to the same `ModelDetails`: `model_id`, `display_model_id`, `display_name`,
`display_name_short`, and each entry of `aliases`. Resolution is an exact lookup after lowercasing.
No fuzzy matching at this layer.

If `--model X` matches nothing (not the parameterised map, not the alias map, not a passthrough
prefix), the reference client exits with
`Cannot use this model: {X}. Available models: {comma-joined display_model_id values}`.

### 10.5.1 Default-model selection ladder `[CONFIRMED]`

The `models` listing only labels the default. Actual session selection resolves in this order:

1. An explicit `--model` value wins.
2. A persisted `selectedModel` whose id is a known parameterised model.
3. If `GetDefaultModelForCli` returned nothing, use the persisted config model if usable, else the
   first entry of `GetUsableModels`, else fail.
4. If the user never changed their default, or the persisted model already equals the server
   default, use the server default, falling back to the first usable model.
5. Otherwise keep the persisted model if it is still in the usable list or parameterised map.
6. If the persisted model cannot be confirmed because the parameterised fetch timed out or
   errored, preserve it anyway rather than resetting.
7. Final fallback: server default, else first usable model, else fail with
   `No model found. Please check your model settings.`

### 10.5.2 Caching and refresh `[CONFIRMED]`

- No on-disk cache of the RPC responses. The persisted config (`model`, `selectedModel`, `maxMode`,
  `modelParameters`) is hydrated at startup and reconciled against the fetched catalogue; if the
  fetch fails the hydrated value is retained.
- Periodic refresh every 600 000 ms (10 minutes), `unref`'d, re-running all three RPCs and
  rebuilding the alias map. The parameterised map is replaced only when status is exactly `loaded`.
- Refreshes are serialised through a promise queue, with a separate single-flight guard on the lazy
  parameterised load.
- If the initial fetch has not resolved after 30 000 ms, a warning is emitted.
- `modelSelectionHistory` is most-recent-first and capped at 32 entries.

### 10.6 Parameterised model syntax `[CONFIRMED]`

A model reference may carry inline parameter overrides:

```
claude-opus-4-8[context=1m,effort=high,fast=false]
```

The bracket grammar is server-defined. The client does not parse it. The whole string is
compared against each parameterised model's variant `legacy_slug` and
`variant_string_representation` values as returned by `AvailableModels`. A match yields
`{ model_id: model.name, parameters: variant.parameter_values }`. `[CONFIRMED]`

A fuzzy ladder is used when mapping a legacy id onto the parameterised catalogue, in order: exact
`name` → `legacy_slugs` contains the id → normalised (lowercase, strip non-alphanumerics) match
against `name` or `client_display_name` → normalised match against any variant's
`display_name_outside_picker` or `display_name` → longest `name` that is a prefix of the id at a
non-alphanumeric boundary.

Well-known parameter ids the client special-cases when rendering a label: `thinking` (boolean;
`"false"` renders as `No Thinking` and it is otherwise hidden), `reasoning`, `fast` (`"true"`
renders as `Fast`), `context`. Default-variant pick order is `is_default_non_max_config` →
`is_default_max_config` → first variant. Boolean parameters with no explicit values default to
`[false, true]`, and values marked `blocked_by_admin_allowlist` are filtered out when any are
present.

Sent on the wire as `agent.v1.RequestedModel`:

```proto
message RequestedModel {
  string model_id                          = 1;
  bool   max_mode                          = 2;
  repeated ModelParameterValue parameters  = 3;
  oneof credentials {
    ApiKeyCredentials  api_key_credentials  = 4;
    AzureCredentials   azure_credentials    = 5;
    BedrockCredentials bedrock_credentials  = 6;
  }
  bool built_in_model                      = 7;
  bool is_variant_string_representation    = 8;
}
```

### 10.7 Hardcoded literals `[CONFIRMED]`

| Literal | Role |
| --- | --- |
| `gpt-5` | Built-in default config entry (display name `GPT-5`, alias `gpt-5`); target of the hidden `gpt5` / `gpt-5` subcommands. |
| `gpt-5.5` | Fallback id for the local provider path only. Never used against the Cursor backend. |
| `opus` | Target of the hidden `opus` subcommand. |
| `sonnet-4` | Target of the hidden `sonnet` subcommand. |
| `composer-2.5`, `composer-2.5-fast` | Rewrite targets for `composer-2` / `composer-2-fast`. |
| `default`, `auto` | Sentinels identifying the auto-routing model. |
| `claude-4.5-haiku`, `claude-4.5-haiku-thinking`, `gemini-2.5-pro`, `gemini-2.5-flash` | Excluded from the parameterised catalogue. |
| `GENERICBASE`, `XAIEXTERNAL` | Id prefixes that bypass catalogue validation. |
| `us-east-1` | Default Bedrock region. |

How the built-in `gpt-5` entry actually behaves. The shipped configuration does carry a default
`ModelDetails` of `gpt-5`, so the "no persisted model" branch of the §10.5.1 ladder is effectively
unreachable in the reference client. That entry is only honoured when it also appears in the
`GetUsableModels` result. It is a persisted preference, not a fallback. If the catalogue does not
contain it, the client errors rather than substituting it. Resolve through `GetDefaultModelForCli`
and treat any local default as a preference to validate against the catalogue, never as a usable
model in its own right.

When Bedrock is enabled, `custom_model_ids` / `additional_model_names` carry a hardcoded list of
inference-profile ids in this order: `claude-sonnet-4-20250514-v1:0`,
`claude-sonnet-4-5-20250929-v1:0`, `claude-sonnet-4-6`, `claude-opus-5`, `claude-sonnet-5`,
`claude-fable-5`, `claude-3-5-haiku-20241022-v1:0`, `claude-haiku-4-5-20251001-v1:0`,
`claude-opus-4-20250514-v1:0`, `claude-opus-4-1-20250805-v1:0`, `claude-opus-4-5-20251101-v1:0`,
`claude-opus-4-6-v1`, `claude-opus-4-7`, `claude-opus-4-8`. Each is prefixed `us.anthropic.`, with the
region prefix rewritten `ap-*` → `apac.`, `eu-*` → `eu.`, `ca-*` → `ca.`, all others staying `us.`.
The first entry of the rewritten list is the Bedrock default. Otherwise both fields are empty.

---

## 11. Running a conversation

### 11.1 Stream envelope

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
    InteractionUpdate           interaction_update             = 1;
    ExecServerMessage           exec_server_message            = 2;
    ConversationStateStructure  conversation_checkpoint_update = 3;
    KvServerMessage             kv_server_message              = 4;
    ExecServerControlMessage    exec_server_control_message    = 5;
    InteractionQuery            interaction_query              = 7;
  }
  TtftBreakdown ttft_breakdown = 8;      // NOT in the oneof
}

message ClientHeartbeat {}               // empty; liveness only
message TtftBreakdown {
  double server_first_token_ms  = 1;
  double pre_stream_setup_ms    = 2;
  double wait_for_first_event_ms= 3;
  optional double provider_ttft_ms = 4;
  double slow_pool_wait_ms      = 5;
}
```

Two things I got wrong on a first pass:

- `ttft_breakdown` is not in the oneof. It may accompany any case, so check it independently
  of `message` on every inbound frame.
- There is no error case in `AgentServerMessage`. Failures arrive as ConnectRPC stream errors
  with a Connect code, never as a protobuf frame. The only soft-error affordance in-band is
  `TextDeltaUpdate.is_server_notice = true`.

Role of each client case: `run_request` is the handshake (exactly one, written first);
`conversation_action` pushes a *subsequent* turn onto an already-running stream (queued message,
cancel, resume) using the same type as `AgentRunRequest.action`; `exec_client_message` and
`exec_client_control_message` are the tool-execution reply channel (§12); `kv_client_message`
answers blob fetches (§11.9); `interaction_response` answers approval prompts (§11.10);
`client_heartbeat` is keepalive (§13.1). `prewarm_request` is never emitted by the reference client
and is not wire-compatible with `AgentRunRequest` despite the overlap. It omits fields 7, 18,
and 25 and renumbers the tail.

### 11.2 The opening message: `AgentRunRequest`

The first client message must be a `run_request`.

| # | Field | Type | Notes |
| --- | --- | --- | --- |
| 1 | `conversation_state` | `ConversationStateStructure` | Empty message for a brand-new conversation. |
| 2 | `action` | `ConversationAction` | The turn. §11.3. |
| 3 | `model_details` | `ModelDetails` | From §10. |
| 9 | `requested_model` | optional `RequestedModel` | Parameterised selection. |
| 4 | `mcp_tools` | `agent.v1.McpTools` | MCP tool catalogue; empty is fine. |
| 5 | `conversation_id` | optional string | UUID; generate one and keep it. |
| 6 | `mcp_file_system_options` | optional `agent.v1.McpFileSystemOptions` | |
| 7 | `skill_options` | optional `agent.v1.SkillOptions` | |
| 8 | `custom_system_prompt` | optional string | |
| 10 | `suggest_next_prompt` | optional bool | |
| 11 | `subagent_type_name` | optional string | |
| 12 | `exclude_workspace_context` | optional bool | Set `true` for a context-free chat client. |
| 13 | `harness` | optional string | Client identifier. The field name is `harness`. |
| 14 | `selected_subagent_models` | repeated `RequestedModel` | |
| 15 | `selected_subagent_model_details` | repeated `ModelDetails` | |
| 16 | `conversation_group_id` | optional string | |
| 17 | `pre_fetched_blobs` | repeated `PreFetchedBlob` | |
| 18 | `dev_raw_model_slug` | optional string | |
| 19 | `client_supports_inline_images` | optional bool | Capability negotiation. |
| 20 | `subagent_model_overrides` | repeated `SubagentModelOverride` | |
| 21 | `can_create_cloud_subagents` | optional bool | |
| 22 | `suppress_subagent_progress_update_tool` | optional bool | |
| 23 | `client_supports_send_to_user` | optional bool | |
| 24 | `computer_use_coordinate_mode` | optional string | |
| 25 | `run_id` | optional string | |
| 26 | `agent_session_id` | optional string | |
| 27 | `client_supports_prompt_context_usage_rpc` | optional bool | |
| 28 | `client_supports_routed_model_update` | optional bool | Enables `routed_model` updates. |

The `client_supports_*` booleans are capability negotiation. Leave them unset (false) and the
server will not emit the corresponding update types. That is the safest posture for a first
implementation.

### 11.3 `ConversationAction`

```proto
message ConversationAction {
  oneof action {
    UserMessageAction                 user_message_action                  = 1;
    ResumeAction                      resume_action                        = 2;
    CancelAction                      cancel_action                        = 3;
    SummarizeAction                   summarize_action                     = 4;
    ShellCommandAction                shell_command_action                 = 5;
    StartPlanAction                   start_plan_action                    = 6;
    ExecutePlanAction                 execute_plan_action                  = 7;
    AsyncAskQuestionCompletionAction  async_ask_question_completion_action = 8;
    CancelSubagentAction              cancel_subagent_action               = 10;
    BackgroundTaskCompletionAction    background_task_completion_action    = 12;
    BackgroundShellAction             background_shell_action              = 13;
    BackgroundSubagentAction          background_subagent_action           = 14;
    SubscriptionNotificationAction    subscription_notification_action     = 16;
    GoalContinuationAction            goal_continuation_action             = 18;
    InjectContextAction               inject_context_action                = 19;
  }
  optional string             triggering_auth_id    = 11;
  optional TriggeringUserInfo triggering_user_info  = 15;
  optional RequestContextParts request_context_parts= 17;
}

message UserMessageAction {
  UserMessage user_message                                  = 1;
  RequestContext request_context                            = 2;
  optional bool send_to_interaction_listener                = 3;
  repeated UserMessage prepend_user_messages                = 4;
  optional InterruptedPendingToolCallResolutions
                    interrupted_pending_tool_call_resolutions = 6;
  optional ConversationHistory conversation_history         = 7;
}

message ResumeAction { RequestContext request_context = 2; }
message CancelAction {
  string reason = 1;
  optional InterruptedPendingToolCallResolutions
           interrupted_pending_tool_call_resolutions = 3;
}
```

### 11.4 `UserMessage`

| # | Field | Type | Notes |
| --- | --- | --- | --- |
| 1 | `text` | string | Plain-text prompt. |
| 2 | `message_id` | string | Client-generated UUID. |
| 3 | `selected_context` | optional `SelectedContext` | Explicit @-mentions and selections. |
| 4 | `mode` | `AgentMode` | See below. |
| 5 | `is_simulated_msg` | optional bool | |
| 8 | `rich_text` | optional string | Serialised rich-text document. |
| 9 | `simulated_msg_reason` | optional enum | |
| 10 | `conversation_state_blob_id` | bytes | |
| 13 | `triggering_user_info` | optional `TriggeringUserInfo` | |
| 14 | `execute_plan_info` | optional `ExecutePlanInfo` | |
| 16 | `prompt_reference_id` | optional string | |
| 17 | `thread_id` | optional string | |
| 18 | `text_blob_id` | optional bytes | Out-of-band large text. |
| 19 | `rich_text_blob_id` | optional bytes | |
| 21 | `hook_additional_contexts` | repeated | |
| 22 | `custom_mode_intent` | optional `CustomModeIntent` | |
| 23 | `project_details` | optional `ProjectDetails` | |

Also: 6 `best_of_n_group_id`, 7 `try_use_best_of_n_promotion`, 11 `subagent_system_reminder`,
15 `simulated_message_metadata`.

```proto
enum AgentMode {
  AGENT_MODE_UNSPECIFIED = 0;  AGENT_MODE_AGENT     = 1;  AGENT_MODE_ASK       = 2;
  AGENT_MODE_PLAN        = 3;  AGENT_MODE_DEBUG     = 4;  AGENT_MODE_TRIAGE    = 5;
  AGENT_MODE_PROJECT     = 6;  AGENT_MODE_MULTITASK = 7;  AGENT_MODE_CUSTOM    = 8;
}
```

Use `AGENT_MODE_ASK` for a read-only chat client. It minimises tool-execution demands.

For a minimal client, `{ text, message_id, mode }` suffices. Attachments live in `SelectedContext`:
images, files, code selections, terminals, git state, past chats.

```proto
message SelectedContext {
  repeated SelectedImage selected_images = 1;
  optional InvocationContext invocation_context = 2;
  repeated string extra_context = 3;
  repeated SelectedFile files = 4;
  repeated SelectedCodeSelection code_selections = 5;
  repeated SelectedTerminal terminals = 6;
  repeated SelectedTerminalSelection terminal_selections = 7;
  repeated SelectedFolder folders = 8;
  repeated SelectedExternalLink external_links = 9;
  repeated SelectedCursorRule cursor_rules = 10;
  optional SelectedGitDiffFromBranchToMain git_diff_from_branch_to_main = 11;
  repeated SelectedCursorCommand cursor_commands = 12;
  repeated SelectedDocumentation documentations = 13;
  repeated SelectedUIElement ui_elements = 14;
  repeated SelectedConsoleLog console_logs = 15;
  repeated ExtraContextEntry extra_context_entries = 16;
  repeated SelectedGitCommit git_commits = 17;
  optional SelectedGitDiff git_diff = 18;
  repeated SelectedPastChat past_chats = 19;
  repeated SelectedGitPRDiffSelection git_pr_diff_selections = 20;
  repeated SelectedPullRequest selected_pull_requests = 21;
  repeated SelectedSubagent selected_subagents = 22;
  repeated SelectedVideo selected_videos = 23;
  repeated SelectedBrowser selected_browsers = 24;
  repeated SelectedDocument selected_documents = 25;
  repeated AgentSkill selected_skills = 26;
  optional RecentAgentsContext recent_agents_context = 27;
  optional SelectedAgenticGitAction selected_agentic_git_action = 34;
}

message SelectedImage {
  oneof data_or_blob_id {
    bytes blob_id                     = 1;
    bytes data                        = 8;   // raw bytes inline
    BlobIdWithData blob_id_with_data  = 9;   // { bytes blob_id = 1; bytes data = 2 }
    PromptUploadRef prompt_upload_ref = 10;  // { string upload_id = 1 }
  }
  string uuid = 2;  string path = 3;
  Dimension dimension = 4;                   // { int32 width = 1; int32 height = 2 }
  string mime_type = 7;
}
```

For very large media there is the out-of-band unary
`agent.v1.AgentService/GetSignedUrlForAttachedMedia`, which returns `post_url` / `put_url` /
`get_url` / `post_fields`, paired with `PromptUploadRef`.

### 11.4.1 Tool declaration

The client declares only MCP tools. Built-in tools are entirely server-side knowledge.

```proto
message McpTools { repeated McpToolDefinition mcp_tools = 1; }
message McpToolDefinition {
  string name                        = 1;  // fully-qualified name shown to the model
  string description                 = 2;
  google.protobuf.Struct input_schema= 3;  // JSON Schema as a Struct
  string provider_identifier         = 4;
  string tool_name                   = 5;  // bare name on the MCP server
  optional string input_schema_json  = 6;
}
```

### 11.5 `RequestContext`, describing the client's world

Large message; a minimal client can send `env` and little else. Selected fields:

| # | Field | Type |
| --- | --- | --- |
| 2 | `rules` | repeated `Rule` |
| 4 | `env` | `RequestContextEnv` |
| 6 | `repository_info` | repeated `RepositoryIndexingInfo` |
| 7 | `tools` | repeated `Tool` |
| 11 | `git_repos` | repeated `GitRepoInfo` |
| 13 | `project_layouts` | repeated |
| 17 | `web_search_enabled` | optional bool |
| 20 | `file_contents` | `map<string,string>` |
| 24 | `web_fetch_enabled` | optional bool |
| 28 | `hooks_config` | optional `HooksConfigInfo` |
| 32 | `supports_mcp_auth` | optional bool |
| 35 | `read_lints_enabled` | optional bool |
| 39 to 45 | `*_info_complete` | bool, signals partial context |
| 46 to 48 | `*_permissions_auto_run` | `PermissionsAutoRunInstructions` |
| 50 | `search_conversations_enabled` | optional bool |
| 51 | `send_message_enabled` | optional bool |
| 52 | `admin_command_denylist` | repeated string |

```proto
message RequestContextEnv {
  string os_version                     = 1;
  repeated string workspace_paths       = 2;
  string shell                          = 3;
  bool   sandbox_enabled                = 5;
  string terminals_folder               = 7;
  string agent_shared_notes_folder      = 8;
  string agent_conversation_notes_folder= 9;
  string time_zone                      = 10;
  string project_folder                 = 11;
  string agent_transcripts_folder       = 12;
  optional string artifacts_folder      = 13;
  optional bool sandbox_supported       = 14;
  optional bool secret_redaction_enabled= 18;
  optional bool computer_use_supported  = 19;
  optional bool is_working_dir_home_dir = 20;
  optional string process_working_directory = 21;
  repeated MountedAgentStore mounted_agent_stores = 25;
  // + sandbox network settings 16/17, smart-mode classifier 22 to 24
}

message GitRepoInfo {
  string path                          = 1;
  string status                        = 2;
  string branch_name                   = 3;
  optional string remote_url           = 4;
  optional bool previous_branch_is_ancestor = 5;
  optional bool is_origin_backed       = 6;
}
```

### 11.6 `InteractionUpdate`, the response stream

This is the message an implementer spends most of their time on.

| # | Case | Payload | Meaning |
| --- | --- | --- | --- |
| 1 | `text_delta` | `TextDeltaUpdate` | Assistant text chunk. |
| 2 | `tool_call_started` | `ToolCallStartedUpdate` | Tool invocation began. |
| 3 | `tool_call_completed` | `ToolCallCompletedUpdate` | Tool invocation finished. |
| 4 | `thinking_delta` | `ThinkingDeltaUpdate` | Reasoning chunk. |
| 5 | `thinking_completed` | `ThinkingCompletedUpdate` | Reasoning finished. |
| 6 | `user_message_appended` | `UserMessageAppendedUpdate` | Echo of an accepted user message. |
| 7 | `partial_tool_call` | `PartialToolCallUpdate` | Streaming tool arguments. |
| 8 | `token_delta` | `TokenDeltaUpdate` | Incremental token count. |
| 9 | `summary` | `SummaryUpdate` | |
| 10 | `summary_started` | `SummaryStartedUpdate` | |
| 11 | `summary_completed` | `SummaryCompletedUpdate` | |
| 12 | `shell_output_delta` | `ShellOutputDeltaUpdate` | |
| 13 | `heartbeat` | `HeartbeatUpdate` | Empty keepalive. |
| 14 | `turn_ended` | `TurnEndedUpdate` | Terminal for the turn. |
| 15 | `tool_call_delta` | `ToolCallDeltaUpdate` | Typed incremental tool progress. |
| 16 | `step_started` | `StepStartedUpdate` | |
| 17 | `step_completed` | `StepCompletedUpdate` | |
| 18 | `prompt_suggestion` | `PromptSuggestionUpdate` | |
| 19 | `post_request_prompt` | `PostRequestPromptUpdate` | |
| 20 | `active_branch_change` | `ActiveBranchChange` | |
| 21 | `feedback_request` | `FeedbackRequestUpdate` | |
| 22 | `response_comparison` | `ResponseComparisonUpdate` | |
| 23 | `context_injection_state` | `ContextInjectionStateUpdate` | |
| 24 | `routed_model` | `RoutedModelUpdate` | Which concrete model the router picked. |

Payload shapes:

```proto
message TextDeltaUpdate       { string text = 1; bool is_server_notice = 2; }
message ThinkingDeltaUpdate   { string text = 1; optional ThinkingStyle thinking_style = 2; }
message ThinkingCompletedUpdate { int32 thinking_duration_ms = 1; }
message TokenDeltaUpdate      { int32 tokens = 1; }
message HeartbeatUpdate       {}
message StepStartedUpdate     { uint64 step_id = 1; }
message StepCompletedUpdate   { uint64 step_id = 1; int64 step_duration_ms = 2; }
message UserMessageAppendedUpdate { UserMessage user_message = 1; }

message ToolCallStartedUpdate   { string call_id = 1; ToolCall tool_call = 2; string model_call_id = 3; }
message ToolCallCompletedUpdate { string call_id = 1; ToolCall tool_call = 2; string model_call_id = 3; }
message PartialToolCallUpdate   { string call_id = 1; ToolCall tool_call = 2;
                                  string args_text_delta = 3; string model_call_id = 4; }

message TurnEndedUpdate {
  optional int64 input_tokens       = 1;
  optional int64 output_tokens      = 2;
  optional int64 cache_read_tokens  = 3;
  optional int64 cache_write_tokens = 4;
  optional int64 reasoning_tokens   = 5;
}

enum ThinkingStyle {
  THINKING_STYLE_UNSPECIFIED = 0;
  THINKING_STYLE_DEFAULT     = 1;
  THINKING_STYLE_CODEX       = 2;
  THINKING_STYLE_GPT5        = 3;
}

message ToolCallDeltaUpdate { string call_id = 1; ToolCallDelta tool_call_delta = 2;
                              string model_call_id = 3; }
message ToolCallDelta {
  oneof delta {
    ShellToolCallDelta      shell_tool_call_delta       = 1;
    TaskToolCallDelta       task_tool_call_delta        = 2;
    EditToolCallDelta       edit_tool_call_delta        = 3;
    ReplaceEnvToolCallDelta replace_env_tool_call_delta = 4;
  }
}

message SummaryStartedUpdate   {}                                  // compaction began
message SummaryUpdate          { string summary = 1; }
message SummaryCompletedUpdate { optional string hook_message = 1; }

message ShellOutputDeltaUpdate {                                   // server-side shell only
  oneof event {
    ShellStreamStdout stdout = 1;   // { string data = 1 }
    ShellStreamStderr stderr = 2;   // { string data = 1 }
    ShellStreamExit   exit   = 3;   // { uint32 code=1; string cwd=2; bool aborted=4; … }
    ShellStreamStart  start  = 4;   // { optional SandboxPolicy sandbox_policy = 1 }
  }
}

message PromptSuggestionUpdate      { string suggestion = 1; }
message RoutedModelUpdate           { string display_name = 1; }   // model the router chose
message ActiveBranchChange          { string path = 1; string branch_name = 2; }
message ContextInjectionStateUpdate { string injection_id = 1; ContextInjectionState state = 2; }
message PostRequestPromptUpdate {
  string title = 1; string message = 2; string button_label = 3; string button_url = 4;
}

message FeedbackRequestUpdate {
  string request_id = 1;
  optional string canonical_model_name = 2;
  repeated FeedbackRequestCategory categories = 3;         // { string id = 1; string label = 2 }
  repeated FeedbackRequestCategoryGroup category_groups = 4;
  bool show_form_immediately = 5;
  optional string title = 6;  optional string negative_title = 7;
  optional string comment_placeholder = 8;
}

message ResponseComparisonUpdate {
  string comparison_id = 1;
  oneof event {
    ResponseComparisonStarted   started    = 2;
    ResponseComparisonTextDelta text_delta = 3;   // { string text = 1 }
    ResponseComparisonCompleted completed  = 4;   // empty
    ResponseComparisonSkipped   skipped    = 5;   // { ResponseComparisonSkipReason reason = 1 }
  }
}
```

`is_server_notice` on a text delta marks out-of-band operational messaging (quota warnings, model
substitution notices) rather than model output. Render it distinctly.

A minimal consumer accumulates `text_delta.text`, stops at `turn_ended`, and reads its token
counts. The rest can wait.

### 11.7 `ToolCall`

A wide oneof (70+ cases) describing what the agent is doing, for display. Field 57 is
`tool_call_id` (optional string); 59/60 are `started_at_ms` / `completed_at_ms` (uint64).
Representative cases: `shell_tool_call` 1, `delete_tool_call` 3, `glob_tool_call` 4,
`grep_tool_call` 5, `read_tool_call` 8, `update_todos_tool_call` 9, `read_todos_tool_call` 10,
`edit_tool_call` 12, `ls_tool_call` 13, `read_lints_tool_call` 14, `mcp_tool_call` 15,
`sem_search_tool_call` 16, `create_plan_tool_call` 17, `web_search_tool_call` 18,
`task_tool_call` 19, `fetch_tool_call` 24, `switch_mode_tool_call` 25,
`generate_image_tool_call` 28, `computer_use_tool_call` 30, `web_fetch_tool_call` 37,
`ask_question_tool_call` 23, `await_tool_call` 42, `get_mcp_tools_tool_call` 44,
`send_message_tool_call` 55, `send_to_user_tool_call` 58, `pi_*_tool_call` 61 to 67,
`create_goal_tool_call` 70, `update_goal_tool_call` 71, `adopt_tool_call` 72.

A client that does not execute tools can render these opaquely from `tool_call_id` and the case
name.

### 11.8 `ConversationStateStructure`, checkpoints

Streamed down as `conversation_checkpoint_update`. It is the complete resumable state of the
conversation.

Miss this and resume will fail. Conversation history is not sent inline. The `bytes` members below
are content-addressed blob IDs, not payloads. The server pulls the bodies back over the KV channel
(§11.9) as it needs them. A client that stores checkpoints must also implement a blob store keyed
by those IDs, or the next turn will fail.

| # | Field | Type |
| --- | --- | --- |
| 1 | `root_prompt_messages_json` | repeated bytes |
| 3 | `todos` | repeated bytes |
| 4 | `pending_tool_calls` | repeated string |
| 5 | `token_details` | `ConversationTokenDetails` |
| 6 | `summary` | optional bytes |
| 7 | `plan` | optional bytes |
| 8 | `turns` | repeated bytes |
| 9 | `previous_workspace_uris` | repeated string |
| 10 | `mode` | optional `AgentMode` |
| 11 | `summary_archive` | optional bytes |
| 12 | `file_states` | `map<string, bytes>` |
| 13 | `summary_archives` | repeated bytes |
| 14 | `turn_timings` | repeated `StepTiming` |
| 15 | `file_states_v2` | `map<string, FileStateStructure>` |
| 16 | `subagent_states` | `map<string, SubagentPersistedState>` |
| 17 | `self_summary_count` | uint32 |
| 18 | `read_paths` | repeated string |
| 19 | `active_branch_name` | optional string |
| 20 | `plans` | `map<string, PlanRegistryEntry>` |
| 21 | `tracked_git_repo_branches` | repeated `TrackedGitRepo` |
| 22 | `agent_type` | optional string |
| 23 | `communicate_update_history` | repeated |
| 24 | `subagent_threads` | `map<string,string>` |
| 26 | `conversation_started_timestamp_ms` | optional uint64 |
| 27 | `conversation_started_time_zone` | optional string |
| 31 | `subagent_state_refs` | `map<string, bytes>` |
| 32 | `goal_state` | optional `GoalState` |
| 34 | `completed_ask_question_tool_call_ids` | repeated string |

```proto
message ConversationTokenDetails {
  uint32 used_tokens = 1;
  uint32 max_tokens  = 2;
  optional PromptTokenBreakdownSnapshot breakdown = 3;
  optional PromptContextUsageTree prompt_context_usage_tree = 4;
  optional bytes prompt_context_usage_snapshot_blob_id      = 5;
}
```

Persist the most recent checkpoint. It is the input to resume (§13) and to the next turn. A
checkpoint that arrives after `turn_ended` is marked ineligible for resume.

For a brand-new conversation, send an empty `ConversationStateStructure{}` and be ready to answer
blob fetches for any ID you did reference.

### 11.9 The blob (KV) channel

```proto
// server → client
message KvServerMessage {
  uint32 id = 1;
  oneof message {
    GetBlobArgs get_blob_args = 2;   // { bytes blob_id = 1 }
    SetBlobArgs set_blob_args = 3;   // { bytes blob_id = 1; bytes blob_data = 2 }
  }
  optional SpanContext span_context = 4;
}

// client → server
message KvClientMessage {
  uint32 id = 1;                     // MUST echo KvServerMessage.id
  oneof message {
    GetBlobResult get_blob_result = 2;   // { optional bytes blob_data = 1; optional Error error = 2 }
    SetBlobResult set_blob_result = 3;   // { optional Error error = 1 }
  }
}
// Error { string message = 1; }
```

The client must implement a content-addressed store keyed by `bytes blob_id`, because the server
will demand the body of any blob ID referenced in `ConversationStateStructure` or in
`UserMessage.text_blob_id` / `rich_text_blob_id` / `conversation_state_blob_id`. A miss is reported
by setting `error` on `GetBlobResult`.

`AgentRunRequest.pre_fetched_blobs` (field 17, `{ bytes id = 1; bytes value = 2; }`) lets you push
bodies up front and avoid the round trips.

#### 11.9.1 Skip the blob store

A client that does not want to implement a blob store can instead send a provider-agnostic
transcript inline via `UserMessageAction.conversation_history` (field 7):

```proto
message ConversationHistory {
  repeated ConversationHistoryMessage messages = 1;
  optional bool replace_user_info               = 2;
}
message ConversationHistoryMessage {
  oneof message {
    ConversationHistoryUserMessage      user      = 1;
    ConversationHistoryAssistantMessage assistant = 2;
    ConversationHistoryToolMessage      tool      = 3;
  }
}
message ConversationHistoryUserContent {
  oneof content {
    ConversationHistoryTextContent  text  = 1;   // { string text = 1 }
    ConversationHistoryImageContent image = 2;   // { string data = 1; optional string mime_type = 2 }
  }
}
message ConversationHistoryAssistantContent {
  oneof content {
    ConversationHistoryTextContent             text               = 1;
    ConversationHistoryReasoningContent        reasoning          = 2; // { text, optional signature }
    ConversationHistoryRedactedReasoningContent redacted_reasoning = 3; // { string data = 1 }
    ConversationHistoryToolCall                tool_call          = 4; // { tool_call_id, tool_name, args_json }
  }
}
message ConversationHistoryToolMessage {
  string tool_call_id = 1;
  string tool_name    = 2;
  repeated ConversationHistoryToolResultContent content = 3;  // oneof { text = 1; image = 2 }
  optional bool is_error = 4;
  repeated HookAdditionalContext hook_additional_contexts = 5;
}
```

This is the recommended path for a third-party client: it is an ordinary chat transcript with no
content addressing.

For the persisted (non-portable) shape, a turn is a sequence of:

```proto
message ConversationStep {
  oneof message {
    AssistantMessage assistant_message = 1;   // { string text = 1 }
    ToolCall         tool_call         = 2;
    ThinkingMessage  thinking_message  = 3;   // { string text = 1; uint32 duration_ms = 2 }
  }
}
```

### 11.10 Interaction queries, the server asking the user

The server can request a decision mid-turn:

```proto
message InteractionQuery {
  uint32 id = 1;
  oneof query {
    WebSearchRequestQuery          web_search_request_query      = 2;
    AskQuestionInteractionQuery    ask_question_interaction_query= 3;
    SwitchModeRequestQuery         switch_mode_request_query     = 4;
    CreatePlanRequestQuery         create_plan_request_query     = 7;
    SetupVmEnvironmentArgs         setup_vm_environment_args     = 8;
    WebFetchRequestQuery           web_fetch_request_query       = 9;
    PrManagementRequestQuery       pr_management_request_query   = 10;
    McpAuthRequestQuery            mcp_auth_request_query        = 11;
    GenerateImageRequestQuery      generate_image_request_query  = 12;
    ReplaceEnvArgs                 replace_env_args              = 13;
    ConnectScmRequestQuery         connect_scm_request_query     = 14;
  }
}

message InteractionResponse {
  uint32 id = 1;               // MUST echo InteractionQuery.id
  oneof result { /* parallel field numbers 2,3,4,7,8,9,10,11,12,13,14 */ }
}
```

The `id` correlates request and response, and the response field numbers deliberately parallel the
query field numbers. Most result messages follow the shape
`oneof result { Approved approved = 1; Rejected rejected = 2; }` with `Rejected { string reason = 1 }`.
`ConnectScm` adds a third `failed { string error = 1 }` case, and `GenerateImageApproved` carries
`{ string description = 1 }`.

A client that auto-approves everything can reply immediately with the `approved` variant. A client
that declines a query type must still respond with the `rejected` variant. Leaving it unanswered
hangs the turn.

---

## 12. Tool execution round trips

There are three distinct tool paths. Mixing them up is the easiest way to build an
incompatible client.

| Path | Trigger | Client obligation |
| --- | --- | --- |
| Server-executed | `interaction_update.tool_call_*` | None. Display only. |
| Client-executed | `exec_server_message` | Must reply with a matching `exec_client_message`. |
| Approval / input | `interaction_query` | Must reply with a matching `interaction_response`. |

### 12.1 Server-executed tools (notification only)

For most tools the server runs the tool itself and reports what happened. The client receives, in order:
zero or more `partial_tool_call` (streaming arguments via `args_text_delta`), then
`tool_call_started`, then zero or more `tool_call_delta` (only for shell, task, edit, and
replace_env), then `tool_call_completed` whose `tool_call` now carries the result. The client
sends nothing back.

Three different correlation ids appear and are *not* interchangeable:

| Id | Scope |
| --- | --- |
| `call_id` | Transport-level, spans `partial` → `started` → `delta` → `completed`. |
| `model_call_id` | The id the underlying LLM assigned. |
| `ToolCall.tool_call_id` (field 57) | Durable id used in history and in hook/interaction messages. `AskQuestionInteractionQuery.tool_call_id` matches this field, not `call_id`. |

Server-executed tools include `sem_search`, `task`, `update_todos` / `read_todos`, `web_search`,
`web_fetch`, `create_plan`, `switch_mode`, `generate_image`, `pr_management`,
`blame_by_file_path`, `set_active_branch`, `send_message`, `send_to_user`, `communicate_update`,
`reflect`, and the grind / goal / CI tools.

### 12.2 Client-executed tools (the exec channel)

For anything that must touch the user's machine, the agent's tools run on the client, and the
server drives them over the same stream.

```
message ExecServerMessage {
  uint32 id      = 1;          // correlation id
  string exec_id = 15;         // stable execution identifier
  oneof message { shell_args = 2, write_args = 3, delete_args = 4, grep_args = 5,
                  read_args = 7, ls_args = 8, diagnostics_args = 9,
                  request_context_args = 10, mcp_args = 11, … }
}

message ExecClientMessage {
  uint32 id      = 1;          // MUST equal the ExecServerMessage.id
  string exec_id = 15;
  optional int32 local_execution_time_ms = 39;
  repeated HookAdditionalContext hook_additional_contexts = 45;
  oneof message { shell_result = 2, write_result = 3, delete_result = 4, grep_result = 5,
                  read_result = 7, ls_result = 8, diagnostics_result = 9,
                  request_context_result = 10, mcp_result = 11,
                  shell_stream = 14, background_shell_spawn_result = 16,
                  fetch_result = 20, computer_use_result = 22,
                  subagent_result = 28, … }
}
```

Protocol rules `[CONFIRMED]`:

- Every `exec_server_message` demands exactly one terminal `exec_client_message` with the same
  `id` and `exec_id`.
- `_args` and `_result` field numbers match within a pair (e.g. `grep_args` 5 ↔ `grep_result` 5),
  with two historical exceptions: `mini_swe_agent_bash` is 52 server-side but 55 client-side,
  and the `pi_*` family is 45 to 51 server-side but 46 to 52 client-side.
- `shell_stream` (case 14) is a non-terminal progress message; the terminal `shell_result`
  still follows.
- `request_context_args` / `request_context_result` is how the server pulls fresh workspace context
  mid-conversation rather than relying on what was sent in the run request. The reference client
  computes and injects the resulting `RequestContext` into the pending action for
  `user_message_action` and `resume_action` before sending.

Control messages:

```proto
message ExecClientControlMessage {
  oneof message {
    ExecClientStreamClose stream_close = 1;  // { uint32 id = 1 } end of a streaming result
    ExecClientThrow       throw        = 2;  // { id, error, optional stack_trace, optional error_code }
    ExecClientHeartbeat   heartbeat    = 3;  // { uint32 id = 1 } long-running exec is alive
  }
}
message ExecServerControlMessage {
  oneof message { ExecServerAbort abort = 1; }   // { uint32 id = 1 } cancel that exec
}
```

Replying `exec_client_control_message.throw` with the matching `id` is the correct way to decline a
tool you do not implement.

The full client-executed set: shell (one-shot, streaming, background, force-background, stdin
write), file write / delete / read / redacted-read / ls / grep, diagnostics and lints, MCP
invocation plus resource listing / reading and MCP state, request-context computation, fetch,
record-screen, computer-use, subagent spawn / await, hook execution, git diff, conversation search,
agent-store conflict resolution, adopt, the `pi_*` family, allowlist prechecks, and the smart-mode
classifier.

A client that only wants text generation should advertise no tools in `RequestContext.tools`,
use `AGENT_MODE_ASK`, set `exclude_workspace_context = true`, and reply to any unexpected
`exec_server_message` with the corresponding error or abort result rather than ignoring it.

---

## 13. Reliability: heartbeats, checkpoints, resume

### 13.1 Heartbeats and stall detection `[CONFIRMED]`

`ClientHeartbeat` (case 7 of `AgentClientMessage`) and `HeartbeatUpdate` (`InteractionUpdate`
case 13) are both empty messages.

- The client starts a 5000 ms repeating timer immediately after the stream is set up, right
  after `run_request` is written and the response iterator is wired. It is a fixed interval, not
  an idle timer. It fires unconditionally and is not reset by other outbound traffic. Cleared when
  the turn finishes or the stream tears down.
- A stall detector runs alongside with a default threshold of 30 000 ms of no inbound
  activity. Any inbound frame, including a server heartbeat, resets it. Tripping it aborts the
  stream with source `stall_detector`, which triggers the retry path.
- A server heartbeat counts as "first message" but not as "first non-heartbeat response".
- On HTTP/2 the transport also pings every 10 s with a 20 s timeout, covering transport
  liveness independently.

A compatible client sends `client_heartbeat` at least every few seconds during long turns, and
treats more than 30 s of inbound silence as a dead stream.

### 13.2 Retry and resume loop `[CONFIRMED]`

```
attempt          = 0
originalRequestId= uuid_v4()
attemptRequestId = originalRequestId
state            = initial_conversation_state
action           = initial_action

loop:
    if cancelled: raise Cancelled(attemptRequestId)

    if attempt > 0:
        attemptRequestId = uuid_v4()          # NEW id per attempt
        if action is resume_action: notify "resuming from checkpoint"

    try:
        run_one_attempt(state, action, attemptRequestId)
        # every conversation_checkpoint_update received during the attempt
        # updates `state` and records a resume-eligibility flag
        return
    catch retryable_error:
        if latest_checkpoint exists and resume_eligible:
            state  = latest_checkpoint
            action = ResumeAction{ request_context: fresh_request_context() }
        attempt += 1
        sleep(backoff(attempt))
```

Backoff `[CONFIRMED]`:

```
base  = 1000 ms            (100 ms in test mode)
delay = min(base × 2^attempt, 60000 ms)
jitter= uniform(0, delay × 0.2)          # 20 % additive jitter
sleep(delay + jitter)                     # interruptible by cancellation
```

Note this differs from the auth poll backoff (§5.1), which uses a 1.2 multiplier, a 10 s cap, and no
jitter.

Actions excluded from certain retry paths: `shell_command_action`,
`background_task_completion_action`, `goal_continuation_action`. `[INFERRED]`

### 13.3 Connection state reporting

Observable states are `connected`, `reconnecting{attempt, startedAtMs, endpointUrl}`, and `failed`.
The reference UI suppresses the endpoint hostname until attempt ≥ 2.

---

## 14. Error handling

### 14.1 Connect error mapping

Non-`2xx` responses carry a Connect error. Derive the code from the HTTP status per the Connect
specification, then override with `code` from the JSON body when present. Preserve `details`, which
may carry typed protobuf error payloads. The reference client extracts one such detail type to
add context to inference failures.

### 14.2 Authentication failure detection `[CONFIRMED]`

Treat as an auth failure when either:

- the Connect error code is `Unauthenticated`, or
- the error message, lowercased, contains any of: `401`, `unauthorized`, `unauthenticated`,
  `authentication failed`, `invalid token`, `token expired`.

On detection, clear stored credentials and raise a distinct "invalid token, please log in
again" error. Clearing must not itself throw.

### 14.3 Sign-in policy violation

A `403` whose JSON body has `error == "sign_in_policy_violation"` is terminal and must not be
retried. Report it as an organisational device-policy rejection.

### 14.4 Network failures

Wrap transport-level failures in an error that names the configured proxy (credentials stripped) or
suggests setting `HTTPS_PROXY`.

### 14.5 Streaming errors

A frame with the end-of-stream bit set and an `error` member terminates the stream. Propagate
`error.message` and `error.code`; there is no partial-success semantics.

---

## 15. Environment variables

| Variable | Effect |
| --- | --- |
| `CURSOR_API_ENDPOINT` | Override API base URL. |
| `CURSOR_API_BASE_URL` | Override API base URL (auth module). |
| `CURSOR_WEBSITE_URL` | Override website base URL. Must not contain `#`. |
| `CURSOR_API_KEY` | API key for automatic exchange. |
| `CURSOR_AUTH_TOKEN` | Raw access token, used verbatim. |
| `AGENT_CLI_CREDENTIAL_STORE` | `file` \| `memory` \| `default` \| unset. |
| `CURSOR_CONFIG_DIR` / `XDG_CONFIG_HOME` | Config directory. |
| `CURSOR_DATA_DIR` | Data directory. |
| `CURSOR_MDM_SIGN_IN_POLICY_JSON` | Override managed-device policy. |
| `CURSOR_PRIVACY_CACHE_MAX_AGE_MS` | Default `3600000`. |
| `CURSOR_PRIVACY_SAMPLE_RATE` | Default `10`. |
| `CURSOR_AGENT_CLI_LOCAL_MODE` | Adds `local-cli-mode: true` header. |
| `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` | Proxy selection. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Disabled globally when an insecure flag is set. |
| `CURSOR_STATSIG_OVERRIDES` | Feature-flag overrides. |

---

## 16. Minimum viable client

> Contingent on one unverified assumption. Every call below uses JSON encoding, which is
> confirmed only against two telemetry services, never against the model, config, or agent
> endpoints this recipe targets. Run the two probes in §3.4 before building on it. If they fail,
> the message shapes here are unchanged. Only the encoding and framing differ.

```
# ---- 1. Authenticate -------------------------------------------------------
if env.CURSOR_AUTH_TOKEN:
    access = refresh = env.CURSOR_AUTH_TOKEN     # §5.3: stored in both slots
elif env.CURSOR_API_KEY:
    access, refresh = POST {api}/auth/exchange_user_api_key
                           with Authorization: Bearer {CURSOR_API_KEY}, body {}
else:
    verifier  = base64url_nopad(random_bytes(32))
    challenge = base64url_nopad(sha256(ascii(verifier)))
    uuid      = uuid_v4()
    open_browser("{website}/loginDeepControl"
                 + "?challenge={challenge}&uuid={uuid}&mode=login&redirectTarget=cli")
    for attempt in 0..149:
        r = GET "{api}/auth/poll?uuid={uuid}&verifier={verifier}"
        if r.status == 404: sleep(min(1000 * 1.2**attempt, 10000)); continue
        if r.status == 403 and r.json.error == "sign_in_policy_violation": abort
        if r.ok and r.json has accessToken and refreshToken:
            access, refresh = r.json.accessToken, r.json.refreshToken; break
        if 3 consecutive failures: abort
store(access, refresh)

# ---- 2. Header stamping ----------------------------------------------------
function headers():
    return { "authorization":           "Bearer " + current_token(),
             "x-ghost-mode":            ghost_mode ? "true" : "false",   # default "true"
             "x-request-id":            uuid_v4(),
             "x-cursor-client-version": "cli-<your-version>",
             "x-cursor-client-type":    "cli",
             "content-type":            "application/json" }

# ---- 3. Bootstrap ----------------------------------------------------------
# Ghost mode gates the agent host (§8.2) as well as the header, so resolve it
# BEFORE selecting the host. It is fail-closed: true until proven otherwise.
ghost_mode = true

cfg    = POST {api}/aiserver.v1.ServerConfigService/GetServerConfig   {}
useH2  = cfg.http2Config not in (FORCE_ALL_DISABLED, FORCE_BIDI_DISABLED)

priv   = POST {api}/aiserver.v1.DashboardService/GetUserPrivacyMode
              { "inferredPrivacyMode": "PRIVACY_MODE_UNSPECIFIED" }
ghost_mode = priv.privacyMode in (0, 1, 2)      # on failure, leave it true

# Full host selection per §8.2. The exceptions below are not optional.
if agent_endpoint_override:                     # explicit override wins over everything
    agent = agent_endpoint_override
elif {api} contains any of ["localhost", "lclhst.build",
                            "staging.cursor.sh", "dev-staging.cursor.sh"]:
    agent = {api}
elif not useH2:                                 # dedicated hosts are HTTP/2-only
    agent = {api}
elif cfg.agentUrlConfig has BOTH agentUrl and agentnUrl, and both parse as URLs:
    agent = ghost_mode ? cfg.agentUrlConfig.agentUrl : cfg.agentUrlConfig.agentnUrl
else:
    agent = {api}

# ---- 4. Pick a model -------------------------------------------------------
# Issue all three CONCURRENTLY and settle independently (§10.4). Only the
# usable-models call is fatal; a failed default or catalogue must not stop the
# client, and the catalogue is bounded at 2000 ms.
usable, default, catalog = all_settled(
    POST {api}/aiserver.v1.AiService/GetUsableModels        { "customModelIds": [] },
    POST {api}/aiserver.v1.AiService/GetDefaultModelForCli  {},
    with_timeout(2000ms,
      POST {api}/aiserver.v1.AiService/AvailableModels
           { "useModelParameters": true, "doNotUseMarkdown": true,
             "additionalModelNames": [] }))

if usable failed or usable.models is empty: abort        # the only fatal branch
model = (default succeeded ? default.model : null) or first(usable.models)

# ---- 5. Run a turn ---------------------------------------------------------
POST {agent}/agent.v1.AgentService/Run
Content-Type: application/connect+json
<frame 0x00> {
  "runRequest": {
    "conversationState": {},
    "action": {
      "userMessageAction": {
        "userMessage": { "text": "<prompt>",
                         "messageId": "<uuid>",
                         "mode": "AGENT_MODE_ASK" },
        "requestContext": { "env": { "osVersion": "...", "shell": "...",
                                     "timeZone": "...", "workspacePaths": [] } }
      }
    },
    "modelDetails": model,
    "conversationId": "<uuid>",
    "excludeWorkspaceContext": true
  }
}

# start a FIXED 5-second heartbeat as soon as the stream is wired
every 5000ms: send_frame({ "clientHeartbeat": {} })
# and abort if 30s pass with no inbound frame of any kind

for message in decode_frames(response.body):
    reset_stall_timer()
    u = message.interactionUpdate
    if u.textDelta      : emit(u.textDelta.text)          # is_server_notice ⇒ render distinctly
    if u.thinkingDelta  : emit_reasoning(u.thinkingDelta.text)
    if u.turnEnded      : record_usage(u.turnEnded); break
    if message.execServerMessage:
        # decline cleanly rather than ignoring
        send_frame({ "execClientControlMessage": {
            "throw": { "id": message.execServerMessage.id, "error": "tool not implemented" } } })
    if message.interactionQuery:
        send_frame({ "interactionResponse": { "id": message.interactionQuery.id,
                                              /* the `approved` or `rejected` variant */ } })
    if message.kvServerMessage:
        # Dispatch by case. A store request answered with a read result
        # silently loses the blob.
        k = message.kvServerMessage
        if k.getBlobArgs:
            send_frame({ "kvClientMessage": { "id": k.id,
                "getBlobResult": { "blobData": blob_store.get(k.getBlobArgs.blobId) } } })
        if k.setBlobArgs:
            blob_store.put(k.setBlobArgs.blobId, k.setBlobArgs.blobData)
            send_frame({ "kvClientMessage": { "id": k.id, "setBlobResult": {} } })
    if message.conversationCheckpointUpdate:
        save_checkpoint(message.conversationCheckpointUpdate)

# Multi-turn: either persist the checkpoint AND implement the blob store, or skip both and
# pass a plain transcript in userMessageAction.conversationHistory on the next turn.
```

---

## 17. Open questions

Items a live probe would need to settle before shipping:

1. Refresh token redemption. The `refreshToken` from `/auth/poll` is persisted but never sent
   anywhere in the distribution I examined. Either an endpoint exists that this client does not use,
   or browser-login sessions genuinely cannot be silently renewed. `[UNVERIFIED]`
2. `RunPoll` server behaviour. The message shapes are confirmed, but no client in the
   distribution exercises the polling contract. `[UNVERIFIED]`
3. Whether the server accepts JSON encoding on any endpoint this document targets. The
   hand-rolled JSON transport is used only for `AnalyticsService` and `BackgroundComposerService`.
   The model, config, automations, and agent paths all use connect-node with binary encoding. This
   covers both unary `application/json` and streaming `application/connect+json` on the agent host,
   which §16 depends on. Probe both before relying on §16. `[UNVERIFIED]`
4. Server-side validation of `x-cursor-client-version` / `x-cursor-client-type`. I do not know
   whether an unrecognised value is rejected, degraded, or ignored. `[UNVERIFIED]`
5. Exact oneof payload types for several `ToolCall` and `InteractionQuery` cases defined in
   sibling descriptor files. The field numbers and names above are reliable. A handful of message
   type references were resolved heuristically across files and should be re-derived from the
   descriptors directly if you need them. `[UNVERIFIED]`
6. Blob upload threshold. The KV channel mechanics are confirmed (§11.9), but the size at which
   the client offloads text to `text_blob_id` rather than sending it inline was not traced, nor were
   the `UploadConversationBlobs` / `GetSignedUrlForAttachedMedia` upload mechanics. `[UNVERIFIED]`

---

## Appendix A. Protobuf JSON encoding reminders

If you target JSON mode, these mapping rules decide whether your decoder works:

| Proto | JSON |
| --- | --- |
| `snake_case` field | `lowerCamelCase` key (the original name is also accepted on input) |
| `bytes` | base64 string (standard alphabet, padded) |
| `int64` / `uint64` | string, not number |
| `int32` / `uint32` | number |
| enum | the value's name as a string (numbers also accepted on input) |
| `oneof` | exactly one key present, named after the chosen case |
| unset `optional` | key omitted |
| `map<string, X>` | JSON object |

Decode responses with unknown-field tolerance. The server ships new fields ahead of clients, and a
strict decoder will break on a routine deploy.

## Appendix B. Quick reference of constants

| Constant | Value |
| --- | --- |
| Auth poll max attempts | 150 |
| Auth poll backoff | `min(1000 × 1.2^n, 10000)` ms, no jitter |
| Auth poll consecutive-failure budget | 3 |
| JWT expiry safety margin | 300 s |
| Run retry backoff | `min(1000 × 2^n, 60000)` ms + 20 % jitter |
| Client heartbeat interval | 5 000 ms, fixed (not idle-reset) |
| Stall-detector threshold | 30 000 ms of inbound silence |
| Bidi append timeout | `60000 + ceil(bytes / 131072 × 1000)` ms |
| Bidi appends in flight | 16 |
| Model catalogue refresh | 600 000 ms |
| Model init hang warning | 30 000 ms |
| Model selection history cap | 32 entries |
| HTTP/2 pool size | 4 (flag `http2_agent_connection_pool_config` → `poolSize`) |
| HTTP/2 ping interval / timeout | 10 000 / 20 000 ms |
| Happy-Eyeballs attempt timeout | 1 000 ms |
| Server-config wait before fallback | 5 000 ms |
| Parameterised model fetch timeout | 2 000 ms |
| Privacy cache max age | 3 600 000 ms |
| Privacy opportunistic sample rate | 1 in 10 |
| MDM policy cache | 30 000 ms |
| Credential file mode / dir mode | `0600` / `0700` |
