# cursor-rpc-pi

A [Pi](https://github.com/mariozechner/pi-mono) provider that uses `cursor-rpc` as the model backend. Pi owns the agent loop. Cursor answers the model calls.

People keep grabbing `@cursor/sdk` or a community `cursor` provider and expecting this. Those use other provider ids and a different login.

## Install

```bash
pi install npm:cursor-rpc-pi
```

From a checkout:

```bash
pi -e ./packages/cursor-rpc-pi
```

Node.js 22.19 or newer. Provider id is `cursor-rpc`. Models use the custom API id `cursor-connectrpc`.

## Auth

Headless:

```bash
export CURSOR_API_KEY=YOUR_CURSOR_API_KEY
```

Interactive login prints an authorization URL. `streamSimple` will not open a browser for you.

```
/login cursor-rpc
```

Then:

```
/model cursor-rpc/MODEL_ID
```

v1 does not add usage, doctor, or extra slash commands.

## Privacy

Prompts, tool schemas, and tool results go to Cursor. Do not paste live API keys, JWTs, or poll verifiers into issues or docs.

## Packages people mix up

`cursor-rpc-pi` is this plugin. `cursor-rpc` is the protocol library and is not a Pi package. `cursor-rpc-pi-tools` registers `web_fetch` and `web_search`. `@cursor/sdk` is a different Cursor product. Community `cursor` providers use other ids and auth flows.
