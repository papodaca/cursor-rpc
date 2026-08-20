# cursor-rpc-pi

This is a protocol-SDK provider for [Pi](https://github.com/mariozechner/pi-mono). It is not `@cursor/sdk`, not a community `cursor` provider, and not a local Cursor agent. Pi owns the agent loop; Cursor is the model over `cursor-rpc`.

## Install

```bash
pi install npm:cursor-rpc-pi
```

Or load from a checkout:

```bash
pi -e ./packages/cursor-rpc-pi
```

Requires Node.js 22.19 or newer. The provider id is `cursor-rpc`. Models use the custom API id `cursor-connectrpc`.

## Auth

Headless:

```bash
export CURSOR_API_KEY=YOUR_CURSOR_API_KEY
```

Interactive login (authorization URL only; no browser is opened from `streamSimple`):

```
/login cursor-rpc
```

Then pick a model:

```
/model cursor-rpc/MODEL_ID
```

v1 does not add usage, doctor, or extra slash commands.

## Privacy

Prompts, tool schemas, and tool results are sent to Cursor. Do not paste live API keys, JWTs, or poll verifiers into issues or docs.

## Identity

| Package | Role |
| --- | --- |
| `cursor-rpc-pi` | Pi provider plugin |
| `cursor-rpc` | Protocol client used by this plugin |
| `@cursor/sdk` | Unrelated Cursor product SDK |
| community `cursor` providers | Different provider ids and auth flows |
