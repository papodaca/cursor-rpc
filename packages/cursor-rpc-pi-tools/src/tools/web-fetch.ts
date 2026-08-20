import { defineTool } from "@earendil-works/pi-coding-agent";
import { CancelledError, type WebClient } from "cursor-rpc";
import { Type } from "typebox";
import { approveOrDeny } from "../approval.js";
import { applyTruncation, redactToolText, type TruncateFn } from "../format.js";

export type FetchToolDeps = {
  client: Pick<WebClient, "fetch">;
  hasUI: boolean;
  confirm: (title: string, message: string) => Promise<boolean>;
  truncate: TruncateFn;
  formatSize: (bytes: number) => string;
  maxBytes: number;
  maxLines: number;
};

export function fetchDescription(maxBytesLabel: string, maxLines: number): string {
  return `Fetch a URL as Markdown through Cursor's authenticated web backend. Output is truncated to ${maxLines} lines or ${maxBytesLabel} (whichever is hit first). If truncated, the full output is saved to a temp file.`;
}

export const webFetchParameters = Type.Object({
  url: Type.String({ description: "HTTPS URL to fetch" }),
});

export async function executeWebFetch(
  params: { url: string },
  signal: AbortSignal | undefined,
  deps: FetchToolDeps,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }> {
  const url = params.url?.trim() ?? "";
  if (url.length === 0) {
    throw new Error("url is required");
  }
  const decision = await approveOrDeny("Allow this web fetch?", params.url, {
    hasUI: deps.hasUI,
    confirm: deps.confirm,
    signal,
  });
  if (!decision.ok) {
    return textResult(decision.text);
  }
  try {
    const result = await deps.client.fetch(params.url, { signal });
    if (!result.ok) {
      if (result.isTimeout) {
        throw new Error(result.error);
      }
      return textResult(redactToolText(result.error));
    }
    const text = await applyTruncation(result.content, deps);
    return textResult(text);
  } catch (error) {
    if (error instanceof CancelledError) {
      return textResult("Cancelled");
    }
    throw error;
  }
}

export function createWebFetchTool(deps: Omit<FetchToolDeps, "hasUI" | "confirm"> & { maxBytesLabel: string }) {
  return defineTool({
    name: "web_fetch",
    label: "WebFetch",
    description: fetchDescription(deps.maxBytesLabel, deps.maxLines),
    promptSnippet: "Fetch a URL as Markdown with web_fetch",
    promptGuidelines: ["Use web_fetch when you need the Markdown content of a specific URL."],
    parameters: webFetchParameters,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) =>
      executeWebFetch(params, signal, {
        ...deps,
        hasUI: ctx.hasUI,
        confirm: (title, message) => ctx.ui.confirm(title, message, signal ? { signal } : undefined),
      }),
  });
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}
