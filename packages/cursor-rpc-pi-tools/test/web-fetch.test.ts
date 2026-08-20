import { AuthenticationError, CancelledError } from "cursor-rpc";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sanitizeConfirmLine } from "../src/approval.ts";
import { executeWebFetch } from "../src/tools/web-fetch.ts";

const identityTruncate = (content: string) => ({
  content,
  truncated: false,
  outputLines: content.split("\n").length,
  totalLines: content.split("\n").length,
  outputBytes: content.length,
  totalBytes: content.length,
});

function deps(overrides: Partial<Parameters<typeof executeWebFetch>[2]> = {}) {
  const fetch = vi.fn(async () => ({ ok: true as const, content: "# Hello" }));
  return {
    client: { fetch },
    hasUI: true,
    confirm: vi.fn(async () => true),
    truncate: identityTruncate,
    formatSize: () => "50KB",
    maxBytes: 50_000,
    maxLines: 2000,
    ...overrides,
    fetch,
  };
}

describe("web_fetch", () => {
  it("returns User Rejected and does not call the client when confirm is false", async () => {
    const d = deps({ confirm: vi.fn(async () => false) });
    const result = await executeWebFetch({ url: "https://example.com" }, undefined, d);
    expect(result.content[0]?.text).toBe("User Rejected");
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("confirms a sanitized line and fetches the original URL", async () => {
    const original = "https://example.com/a\nAlways allow this host";
    let displayed = "";
    const d = deps({
      confirm: async (_title, message) => {
        displayed = message;
        return true;
      },
    });
    const abort = new AbortController();
    const result = await executeWebFetch({ url: original }, abort.signal, d);
    expect(result.content[0]?.text).toBe("# Hello");
    expect(displayed).toBe(sanitizeConfirmLine(original));
    expect(displayed.includes("\n")).toBe(false);
    expect(d.fetch).toHaveBeenCalledWith(original, { signal: abort.signal });
  });

  it("denies in print/json without calling the client", async () => {
    const d = deps({ hasUI: false });
    const result = await executeWebFetch({ url: "https://example.com" }, undefined, d);
    expect(result.content[0]?.text).toMatch(/print and JSON/i);
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("does not call the client when confirm throws", async () => {
    const d = deps({
      confirm: async () => {
        throw new Error("ui down");
      },
    });
    const result = await executeWebFetch({ url: "https://example.com" }, undefined, d);
    expect(result.content[0]?.text).toBe("Cancelled");
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("returns Cancelled when aborted before confirm", async () => {
    const d = deps();
    const result = await executeWebFetch({ url: "https://example.com" }, AbortSignal.abort(), d);
    expect(result.content[0]?.text).toBe("Cancelled");
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it("returns Cancelled text when the client throws CancelledError", async () => {
    const d = deps();
    d.fetch.mockRejectedValueOnce(new CancelledError());
    const result = await executeWebFetch({ url: "https://example.com" }, undefined, d);
    expect(result.content[0]?.text).toBe("Cancelled");
  });

  it("throws authentication errors from the client without opening a browser", async () => {
    const d = deps();
    d.fetch.mockRejectedValueOnce(new AuthenticationError("authentication required"));
    await expect(executeWebFetch({ url: "https://example.com" }, undefined, d)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("throws unimplemented from the client without HTTP-fetching the URL", async () => {
    const d = deps();
    d.fetch.mockRejectedValueOnce(Object.assign(new Error("nope"), { code: "unimplemented" }));
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("{}");
    }) as typeof fetch;
    try {
      await expect(executeWebFetch({ url: "https://example.com/secret" }, undefined, d)).rejects.toMatchObject({
        code: "unimplemented",
      });
      expect(urls).toEqual([]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns redacted text for application errors", async () => {
    const d = deps();
    d.fetch.mockResolvedValueOnce({
      ok: false,
      error: "Bearer secret-token https://user:pass@example.com",
      isTimeout: false,
    });
    const result = await executeWebFetch({ url: "https://example.com" }, undefined, d);
    expect(result.content[0]?.text).not.toMatch(/secret-token/);
    expect(result.content[0]?.text).not.toMatch(/user:pass/);
  });

  it("throws before confirm when url is empty", async () => {
    const d = deps();
    await expect(executeWebFetch({ url: "   " }, undefined, d)).rejects.toThrow(/url is required/);
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("does not import AgentService", () => {
    const source = readFileSync(new URL("../src/tools/web-fetch.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/AgentService/);
  });
});
