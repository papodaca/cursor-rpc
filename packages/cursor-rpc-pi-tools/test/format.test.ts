import { describe, expect, it } from "vitest";
import { applyTruncation, buildYearGuidance, formatSearchDocuments, redactToolText } from "../src/format.ts";

describe("format", () => {
  it("builds year guidance with a 2026 vs 2025 example", () => {
    const text = buildYearGuidance("2026-08-19");
    expect(text).toContain("web_search");
    expect(text).toContain("2026");
    expect(text).toContain("2025");
    expect(text).toContain("2026-08-19");
  });

  it("throws on a non-YYYY-MM-DD string", () => {
    expect(() => buildYearGuidance("2026/08/19")).toThrow(/YYYY-MM-DD/);
    expect(() => buildYearGuidance("short")).toThrow(/YYYY-MM-DD/);
  });

  it("maps documents to title, url, chunk JSON", () => {
    expect(
      formatSearchDocuments([
        { url: "https://a.example", title: "A", text: "one" },
        { url: "https://b.example", title: "B", text: "two" },
      ]),
    ).toBe(
      JSON.stringify([
        { title: "A", url: "https://a.example", chunk: "one" },
        { title: "B", url: "https://b.example", chunk: "two" },
      ]),
    );
  });

  it("redacts Bearer and URL userinfo", () => {
    const text = redactToolText("Bearer secret-token from https://user:pass@example.com/x");
    expect(text).not.toMatch(/secret-token/);
    expect(text).not.toMatch(/user:pass/);
  });

  it("appends an owner-only spill path when truncated", async () => {
    const { readFile, stat } = await import("node:fs/promises");
    const text = await applyTruncation("hello", {
      truncate: () => ({
        content: "head",
        truncated: true,
        outputLines: 1,
        totalLines: 10,
        outputBytes: 4,
        totalBytes: 60_000,
      }),
      formatSize: (bytes) => `${bytes}B`,
      maxBytes: 50_000,
      maxLines: 2000,
    });
    expect(text.startsWith("head")).toBe(true);
    const match = text.match(/Full output saved to: (.+)\]$/);
    expect(match?.[1]).toBeTruthy();
    const path = match?.[1] ?? "";
    const info = await stat(path);
    expect(info.mode & 0o077).toBe(0);
    const spilled = await readFile(path, "utf8");
    expect(spilled).toBe("hello");
    expect(spilled).not.toMatch(/CURSOR_/);
  });
});
