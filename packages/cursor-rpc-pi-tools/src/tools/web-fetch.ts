import { defineTool } from "@earendil-works/pi-coding-agent";
import { CancelledError, type WebClient } from "cursor-rpc";
import { Type } from "typebox";
import { approveOrDeny, type ApprovalDeps } from "../approval.js";
import {
  applyTruncation,
  redactToolText,
  textResult,
  truncationDescription,
  type TruncationDeps,
} from "../format.js";

export type FetchToolDeps = {
  client: Pick<WebClient, "fetch">;
} & Pick<ApprovalDeps, "hasUI" | "confirm"> &
  TruncationDeps;

export function fetchDescription(maxBytesLabel: string, maxLines: number): string {
  return `Fetch a URL as Markdown through Cursor's authenticated web backend. ${truncationDescription(maxBytesLabel, maxLines)}`;
}

export const webFetchParameters = Type.Object({
  url: Type.String({ description: "HTTPS URL to fetch" }),
});

export async function executeWebFetch(
  params: { url: string },
  signal: AbortSignal | undefined,
  deps: FetchToolDeps,
) {
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

export function createWebFetchTool(deps: Omit<FetchToolDeps, "hasUI" | "confirm">) {
  return defineTool({
    name: "web_fetch",
    label: "WebFetch",
    description: fetchDescription(deps.formatSize(deps.maxBytes), deps.maxLines),
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
