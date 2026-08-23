# cursor-rpc-opencode

OpenCode LanguageModelV3 provider wrapping `cursor-rpc`. Cursor is a language-model backend; OpenCode owns session, tools, permissions, and workspace. Local exec on the Cursor side is fail-closed (empty workspace, no shell or file handlers).

Requires Node.js 22 or later.

Provider id is `cursor`. The package exports `createCursor` (the factory OpenCode loads) and `plugin` (a v1 `config` hook that overlays the signed-in usable catalogue). The hook never opens a browser or starts interactive authentication.

Credentials come from provider `options.apiKey` / `settings.apiKey`, or from `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`. Do not commit those values. Missing credentials fail closed.

An empty `models` map silently skips the package. Install with at least one static seed (shown below). When credentials work, the plugin replaces that seed with live usable rows from `client.models()`. If overlay fails (auth, empty catalogue, transport, timeout), the seed stays.

Build the package first (`npm run build -w cursor-rpc-opencode`). Point `file://` at the built package root or the ESM entry (`dist/index.js`). Use an absolute path. The seed id below is only a loader placeholder (`cursor-rpc`); live rows use catalogue `modelId` values such as `composer-2.5`.

## OpenCode v1

```json
{
  "plugin": ["file:///absolute/path/to/cursor-rpc-opencode"],
  "provider": {
    "cursor": {
      "npm": "file:///absolute/path/to/cursor-rpc-opencode",
      "options": {},
      "models": {
        "cursor-rpc": {
          "id": "cursor-rpc",
          "name": "Cursor RPC",
          "tool_call": true,
          "reasoning": true,
          "attachment": false
        }
      }
    }
  }
}
```

Set `options.apiKey` or export `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` in the environment.

## OpenCode v2

```json
{
  "plugins": ["file:///absolute/path/to/cursor-rpc-opencode"],
  "providers": {
    "cursor": {
      "package": "file:///absolute/path/to/cursor-rpc-opencode",
      "settings": {},
      "models": {
        "cursor-rpc": {
          "id": "cursor-rpc",
          "name": "Cursor RPC",
          "capabilities": { "tools": true },
          "reasoning": true,
          "attachment": false
        }
      }
    }
  }
}
```

`settings` is the v2 options bag (`apiKey` and other factory settings). Catalogue rows advertise `capabilities.tools` from the same tools-supported signal as v1 `tool_call`.

## Factory

```ts
import { createCursor } from "cursor-rpc-opencode";

const cursor = createCursor();
```
