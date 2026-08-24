# cursor-rpc-opencode

OpenCode LanguageModelV3 provider that calls `cursor-rpc`. Node.js 22 or later.

Cursor is the language model. OpenCode owns the session, tools, permissions, and workspace. This package will not run shell or file tools on Cursor's side. Fail closed.

## Install

Build before a local `file://` install:

```bash
npm run build -w cursor-rpc-opencode
```

Point `provider.cursor.npm` on OpenCode v1, or `providers.cursor.package` on v2, at an absolute `file://` URL to the built package root, `packages/cursor-rpc-opencode`. Bun cannot import a directory that has no root `index.js`. Use that package root, or `dist/index.js`, for the factory.

Point `plugin` or `plugins` at `plugin.js` or `dist/plugin.js`. Not the factory. OpenCode treats every export on the plugin module as a plugin function, so the factory file is the wrong entry.

The provider id can be `cursor`. The examples use `cursor-rpc`. The package exports `createCursor`, which is the factory OpenCode loads from the first `create*` export, and `plugin`, which returns a v1 `config` hook and an `auth` hook. The config hook overlays the signed-in usable catalogue on any provider block whose `npm` or `package` field points at this package.

Sign in with `opencode auth login` or `/connect`, then pick the provider id from config. Tokens land in OpenCode's auth store under that same id. You can also set `options.apiKey` or `settings.apiKey`, or export `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN`. Catalogue overlay and generate never start an interactive login.

Missing credentials fail closed.

An empty `models` map silently skips the package. That one bit me. Put at least one static seed in config, like the examples. When credentials work, the plugin replaces that seed with live rows from `client.models()`. If overlay fails because of auth, an empty catalogue, transport, or timeout, the seed stays.

## OpenCode v1

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/packages/cursor-rpc-opencode/plugin.js"],
  "provider": {
    "cursor-rpc": {
      "npm": "file:///absolute/path/to/packages/cursor-rpc-opencode",
      "name": "Cursor RPC",
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

After the plugin is installed, run `opencode auth login` and choose Cursor. Or set `options.apiKey`, or export `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN`.

## OpenCode v2

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/packages/cursor-rpc-opencode/plugin.js"],
  "providers": {
    "cursor-rpc": {
      "package": "file:///absolute/path/to/packages/cursor-rpc-opencode",
      "name": "Cursor RPC",
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

`settings` is the v2 options bag. Catalogue rows set `capabilities.tools` from the same tools-supported signal that v1 calls `tool_call`.

## Factory

```ts
import { createCursor } from "cursor-rpc-opencode";

const cursor = createCursor();
```
