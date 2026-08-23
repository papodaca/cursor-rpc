# cursor-rpc-opencode

OpenCode LanguageModelV3 provider wrapping `cursor-rpc`. Requires **Node.js 22** or later.

Cursor is the language-model backend. **OpenCode owns session, tools, permissions, and workspace.** Cursor local exec is fail-closed: this package does not run shell or file tools on Cursor's side.

Build the package before a local `file://` install:

```bash
npm run build -w cursor-rpc-opencode
```

Point `provider.cursor.npm` (v1) or `providers.cursor.package` (v2) at an absolute `file://` URL to the built package root (`packages/cursor-rpc-opencode`). Bun cannot import a directory without a root `index.js`, so use that package root (or `dist/index.js`) for the factory.

Point `plugin` / `plugins` at the **plugin entry** (`plugin.js` or `dist/plugin.js`), not the factory. OpenCode treats every export on the plugin module as a plugin function.

Provider id can be **`cursor`** or another key such as **`cursor-rpc`**. The package exports `createCursor` (the factory OpenCode loads from the first `create*` export) and a function `plugin` that returns a v1 `config` hook. The hook overlays the signed-in usable catalogue on any provider block whose `npm` / `package` points at this package. It never calls `login()` and never opens a browser.

Credentials come from provider `options.apiKey` / `settings.apiKey`, or from `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`. Missing credentials fail closed.

**An empty `models` map silently skips the package.** Install with at least one static seed (shown below). When credentials work, the plugin **replaces** that seed with live usable rows from `client.models()`. If overlay fails (auth, empty catalogue, transport, timeout), the seed stays.

## OpenCode v1

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/packages/cursor-rpc-opencode/plugin.js"],
  "provider": {
    "cursor": {
      "npm": "file:///absolute/path/to/packages/cursor-rpc-opencode",
      "name": "Cursor",
      "options": {
        "apiKey": "{env:CURSOR_API_KEY}"
      },
      "models": {
        "composer-2.5": {
          "name": "Composer 2.5",
          "tool_call": true
        }
      }
    }
  }
}
```

You can set `options.apiKey` or export `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` in the environment instead.

## OpenCode v2

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/packages/cursor-rpc-opencode/plugin.js"],
  "providers": {
    "cursor": {
      "package": "file:///absolute/path/to/packages/cursor-rpc-opencode",
      "name": "Cursor",
      "settings": {
        "apiKey": "{env:CURSOR_API_KEY}"
      },
      "models": {
        "composer-2.5": {
          "name": "Composer 2.5",
          "capabilities": {
            "tools": true
          }
        }
      }
    }
  }
}
```

`settings` is the v2 options bag. Catalogue rows advertise `capabilities.tools` from the same tools-supported signal as v1 `tool_call`.

## Factory

```ts
import { createCursor } from "cursor-rpc-opencode";

const cursor = createCursor();
```
