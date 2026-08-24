# cursor-rpc-pi-tools

Pi tools `web_fetch` and `web_search`. The model in Pi calls them. Cursor's authenticated unary RPCs return Markdown and search documents.

This is not the `cursor-rpc-pi` model provider. Install that separately if you want Cursor as the model. It is also not `@cursor/sdk`.

## Local install

From this monorepo, after `npm install` and `npm run build -w cursor-rpc`:

```bash
pi install ./packages/cursor-rpc-pi-tools
```

Set `CURSOR_API_KEY` or `CURSOR_AUTH_TOKEN` before a tool runs. Missing credentials fail on the first tool call, not when Pi loads the extension. That delay is easy to misread as "it installed fine."

`pi -p` and JSON mode refuse the tools without hitting the backend. There is no UI to confirm, and there is no auto-approve environment variable.

Skip the registry copy until `cursor-rpc` is published. Install from the path.
