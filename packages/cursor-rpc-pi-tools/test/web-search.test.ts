import { CancelledError } from "cursor-rpc";
import { describe, expect, it, vi } from "vitest";
import { executeWebSearch, searchGuidelines } from "../src/tools/web-search.ts";

const identityTruncate = (content: string) => ({
  content,
  truncated: false,
  outputLines: 1,
  totalLines: 1,
  outputBytes: content.length,
  totalBytes: content.length,
});

function deps(overrides: Partial<Parameters<typeof executeWebSearch>[2]> = {}) {
  const search = vi.fn(async () => ({
    ok: true as const,
    answer: "should omit",
    documents: [
      { url: "https://a.example", title: "A", text: "one" },
      { url: "https://b.example", title: "B", text: "two" },
    ],
  }));
  return {
    client: { search },
    hasUI: true,
    confirm: vi.fn(async () => true),
    now: () => new Date("2026-08-19T00:00:00Z"),
    truncate: identityTruncate,
    formatSize: () => "50KB",
    maxBytes: 50_000,
    maxLines: 2000,
    ...overrides,
    search,
  };
}

describe("web_search", () => {
  it("maps documents to title/url/chunk JSON and omits answer", async () => {
    const d = deps();
    const result = await executeWebSearch({ search_term: "pi tools" }, undefined, d);
    expect(result.content[0]?.text).toBe(
      `[\n${JSON.stringify({ title: "A", url: "https://a.example", chunk: "one" })},\n${JSON.stringify({ title: "B", url: "https://b.example", chunk: "two" })}\n]`,
    );
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([
      { title: "A", url: "https://a.example", chunk: "one" },
      { title: "B", url: "https://b.example", chunk: "two" },
    ]);
    expect(result.content[0]?.text).not.toContain("should omit");
    expect(result.content[0]?.text).not.toContain("answer");
  });

  it("includes web_search and a 2026 vs 2025 example in guidelines", () => {
    const lines = searchGuidelines(new Date("2026-08-19T00:00:00Z"));
    const joined = lines.join(" ");
    expect(joined).toContain("web_search");
    expect(joined).toContain("2026");
    expect(joined).toContain("2025");
  });

  it("returns success JSON array for zero documents", async () => {
    const d = deps();
    d.search.mockResolvedValueOnce({ ok: true, documents: [] });
    const result = await executeWebSearch({ search_term: "nothing" }, undefined, d);
    expect(result.content[0]?.text).toBe("[]");
  });

  it("returns Cancelled text when the client throws CancelledError", async () => {
    const d = deps();
    d.search.mockRejectedValueOnce(new CancelledError());
    const result = await executeWebSearch({ search_term: "pi" }, undefined, d);
    expect(result.content[0]?.text).toBe("Cancelled");
  });

  it("throws before confirm when search_term is empty", async () => {
    const d = deps();
    await expect(executeWebSearch({ search_term: " " }, undefined, d)).rejects.toThrow(/search_term is required/);
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("returns User Rejected and does not call the client when confirm is false", async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    const result = await executeWebSearch({ search_term: "pi tools" }, undefined, d);
    expect(result.content[0]?.text).toBe("User Rejected");
    expect(d.search).not.toHaveBeenCalled();
  });

  it("rebuilds year guidance at execute time", async () => {
    const d = deps({
      now: () => ({ toISOString: () => "not-a-date" }) as Date,
    });
    await expect(executeWebSearch({ search_term: "pi" }, undefined, d)).rejects.toThrow(/YYYY-MM-DD/);
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.search).not.toHaveBeenCalled();
  });
});
