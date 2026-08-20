# cursor-rpc-pi-tools

Pi-installable tools that register `web_fetch` and `web_search`. Pi's model calls them. Cursor's authenticated unary RPCs retrieve Markdown and search documents. This is not `@cursor/sdk` and not the `cursor-rpc-pi` provider stub.

## Local install

From this monorepo, after `npm install` and `npm run build -w cursor-rpc`:

```bash
pi install ./packages/cursor-rpc-pi-tools
```

Requires `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` at tool execute time. Missing credentials fail on the first tool call, not when Pi loads the extension.

Print (`-p`) and JSON modes deny without calling the backend: there is no UI to confirm. There is no auto-approve environment variable.

Do not `npm install cursor-rpc-pi-tools` from the registry until `cursor-rpc` is published. Local path install is the supported development path.
