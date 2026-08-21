import { CursorRpcError } from "cursor-rpc";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TruncateResult = {
  content: string;
  truncated: boolean;
  outputLines: number;
  totalLines: number;
  outputBytes: number;
  totalBytes: number;
};

export type TruncateFn = (content: string, options?: { maxLines?: number; maxBytes?: number }) => TruncateResult;

export type TruncationDeps = {
  truncate: TruncateFn;
  formatSize: (bytes: number) => string;
  maxBytes: number;
  maxLines: number;
};

export type ToolTextResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
};

export type SearchDocument = {
  url: string;
  title: string;
  text: string;
};

export function buildYearGuidance(isoDate: string): string {
  if (isoDate.length !== 10 || isoDate[4] !== "-" || isoDate[7] !== "-") {
    throw new Error("year guidance date must be YYYY-MM-DD");
  }
  const year = isoDate.slice(0, 4);
  const prior = /^\d+$/.test(year) ? String(Number(year) - 1) : year;
  return [
    `Today's date is ${isoDate}.`,
    `When using web_search for recent information, documentation, or current events, use ${year} rather than ${prior}.`,
    `For example, search "Node.js ${year} release notes", not "Node.js ${prior} release notes".`,
  ].join(" ");
}

export function truncationDescription(maxBytesLabel: string, maxLines: number): string {
  return `Output is truncated to ${maxLines} lines or ${maxBytesLabel} (whichever is hit first). If truncated, the full output is saved to a temp file.`;
}

export function textResult(text: string): ToolTextResult {
  return { content: [{ type: "text", text }], details: {} };
}

export function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function formatSearchDocuments(documents: SearchDocument[]): string {
  if (documents.length === 0) {
    return "[]";
  }
  const objects = documents.map((document) =>
    JSON.stringify({
      title: document.title,
      url: document.url,
      chunk: document.text,
    }),
  );
  return `[\n${objects.join(",\n")}\n]`;
}

export function redactToolText(value: string): string {
  return new CursorRpcError(value).message;
}

export async function applyTruncation(text: string, deps: TruncationDeps): Promise<string> {
  const truncation = deps.truncate(text, { maxBytes: deps.maxBytes, maxLines: deps.maxLines });
  if (!truncation.truncated) {
    return truncation.content;
  }
  const counts = `${truncation.outputLines} of ${truncation.totalLines} lines (${deps.formatSize(truncation.outputBytes)} of ${deps.formatSize(truncation.totalBytes)})`;
  try {
    const path = await writeSpill(text);
    return `${truncation.content}\n\n[Output truncated: ${counts}. Full output saved to: ${path}]`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${truncation.content}\n\n[Output truncated: ${counts}. spill failed: ${message}]`;
  }
}

async function writeSpill(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cursor-rpc-pi-tools-"));
  const path = join(dir, "output.txt");
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return path;
}
