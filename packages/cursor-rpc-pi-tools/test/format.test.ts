import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { applyTruncation, buildYearGuidance, formatSearchDocuments, redactToolText } from "../src/format.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
  };
});

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

  it("maps documents to a JSON array with one complete object per line", () => {
    const formatted = formatSearchDocuments([
      { url: "https://a.example", title: "A", text: "one" },
      { url: "https://b.example", title: "B", text: "two" },
    ]);
    expect(formatted).toBe(
      `[\n${JSON.stringify({ title: "A", url: "https://a.example", chunk: "one" })},\n${JSON.stringify({ title: "B", url: "https://b.example", chunk: "two" })}\n]`,
    );
    expect(JSON.parse(formatted)).toEqual([
      { title: "A", url: "https://a.example", chunk: "one" },
      { title: "B", url: "https://b.example", chunk: "two" },
    ]);
  });

  it("emits [] for an empty list", () => {
    expect(formatSearchDocuments([])).toBe("[]");
  });

  it("keeps a truncated head of complete objects when compact JSON exceeds 50KB", async () => {
    const documents = Array.from({ length: 40 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `Doc ${i}`,
      text: "x".repeat(2000),
    }));
    const compact = JSON.stringify(
      documents.map((document) => ({
        title: document.title,
        url: document.url,
        chunk: document.text,
      })),
    );
    expect(compact.includes("\n")).toBe(false);
    expect(Buffer.byteLength(compact, "utf8")).toBeGreaterThan(DEFAULT_MAX_BYTES);
    expect(truncateHead(compact, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES }).content).toBe("");

    const formatted = formatSearchDocuments(documents);
    expect(JSON.parse(formatted)).toEqual(
      documents.map((document) => ({
        title: document.title,
        url: document.url,
        chunk: document.text,
      })),
    );

    const truncated = truncateHead(formatted, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
    expect(truncated.truncated).toBe(true);
    expect(truncated.content.length).toBeGreaterThan(0);

    const objects = truncated.content
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line.replace(/,$/, "")));
    expect(objects.length).toBeGreaterThan(0);
    for (const object of objects) {
      expect(object).toEqual({
        title: expect.any(String),
        url: expect.any(String),
        chunk: expect.any(String),
      });
    }

    const text = await applyTruncation(formatted, {
      truncate: truncateHead,
      formatSize: (bytes) => `${bytes}B`,
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    expect(text.startsWith(truncated.content)).toBe(true);
    expect(text).toMatch(/\[Output truncated: /);
    expect(text).toMatch(/Full output saved to: /);
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

  it("keeps truncated text when spill write fails", async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("disk full"));
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
    expect(text).toBe("head\n\n[Output truncated: 1 of 10 lines (4B of 60000B). spill failed: disk full]");
  });
});
