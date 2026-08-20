import { defineTool } from "@earendil-works/pi-coding-agent";
import { CancelledError, type WebClient } from "cursor-rpc";
import { Type } from "typebox";
import { approveOrDeny } from "../approval.js";
import {
  applyTruncation,
  buildYearGuidance,
  formatSearchDocuments,
  redactToolText,
  utcDateString,
  type TruncateFn,
} from "../format.js";

export type SearchToolDeps = {
  client: Pick<WebClient, "search">;
  hasUI: boolean;
  confirm: (title: string, message: string) => Promise<boolean>;
  now: () => Date;
  truncate: TruncateFn;
  formatSize: (bytes: number) => string;
  maxBytes: number;
  maxLines: number;
};

export function searchDescription(maxBytesLabel: string, maxLines: number): string {
  return `Search the web through Cursor's authenticated backend. Output is truncated to ${maxLines} lines or ${maxBytesLabel} (whichever is hit first). If truncated, the full output is saved to a temp file.`;
}

export const webSearchParameters = Type.Object({
  search_term: Type.String({ description: "Search query" }),
});

export function searchGuidelines(now: Date): string[] {
  return [
    "Use web_search when you need current web references rather than a single known URL.",
    buildYearGuidance(utcDateString(now)),
  ];
}

export async function executeWebSearch(
  params: { search_term: string },
  signal: AbortSignal | undefined,
  deps: SearchToolDeps,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, never> }> {
  const term = params.search_term?.trim() ?? "";
  if (term.length === 0) {
    throw new Error("search_term is required");
  }
  buildYearGuidance(utcDateString(deps.now()));
  const decision = await approveOrDeny("Allow this web search?", params.search_term, {
    hasUI: deps.hasUI,
    confirm: deps.confirm,
    signal,
  });
  if (!decision.ok) {
    return textResult(decision.text);
  }
  try {
    const result = await deps.client.search(params.search_term, { signal });
    if (!result.ok) {
      return textResult(redactToolText(result.error));
    }
    const formatted = formatSearchDocuments(result.documents);
    const text = await applyTruncation(formatted, deps);
    return textResult(text);
  } catch (error) {
    if (error instanceof CancelledError) {
      return textResult("Cancelled");
    }
    throw error;
  }
}

export function createWebSearchTool(
  deps: Omit<SearchToolDeps, "hasUI" | "confirm"> & { maxBytesLabel: string },
) {
  return defineTool({
    name: "web_search",
    label: "WebSearch",
    description: searchDescription(deps.maxBytesLabel, deps.maxLines),
    promptSnippet: "Search the web with web_search",
    promptGuidelines: searchGuidelines(deps.now()),
    parameters: webSearchParameters,
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) =>
      executeWebSearch(params, signal, {
        ...deps,
        hasUI: ctx.hasUI,
        confirm: (title, message) => ctx.ui.confirm(title, message, signal ? { signal } : undefined),
      }),
  });
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text }], details: {} };
}
