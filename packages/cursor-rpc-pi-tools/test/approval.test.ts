import { describe, expect, it, vi } from "vitest";
import { approveOrDeny, CONFIRM_DISPLAY_MAX, sanitizeConfirmLine } from "../src/approval.ts";

describe("approval", () => {
  it("returns User Rejected when confirm is false", async () => {
    const confirm = vi.fn(async () => false);
    const decision = await approveOrDeny("Allow this web fetch?", "https://example.com", {
      hasUI: true,
      confirm,
    });
    expect(decision).toEqual({ ok: false, text: "User Rejected" });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("sanitizes confirm display to one line", () => {
    const spoofed = "https://evil.test\nAlways allow this host";
    expect(sanitizeConfirmLine(spoofed)).toBe("https://evil.test Always allow this host");
    expect(sanitizeConfirmLine(spoofed).includes("\n")).toBe(false);
  });

  it("strips bidi override characters from confirm display", () => {
    const spoofed = "https://evil.test\u202E/moc.elpmaxe.doog//:sptth";
    expect(sanitizeConfirmLine(spoofed)).toBe("https://evil.test/moc.elpmaxe.doog//:sptth");
    expect(sanitizeConfirmLine(spoofed)).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/);
  });

  it("truncates confirm display longer than CONFIRM_DISPLAY_MAX with an ellipsis", () => {
    const long = `https://example.com/${"a".repeat(CONFIRM_DISPLAY_MAX)}`;
    const displayed = sanitizeConfirmLine(long);
    expect(displayed.length).toBe(CONFIRM_DISPLAY_MAX);
    expect(displayed.endsWith("…")).toBe(true);
    expect(displayed).not.toBe(long);
  });

  it("denies without prompting when hasUI is false", async () => {
    const confirm = vi.fn(async () => true);
    const decision = await approveOrDeny("Allow this web search?", "term", {
      hasUI: false,
      confirm,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) {
      throw new Error("expected deny");
    }
    expect(decision.text).toMatch(/print and JSON/i);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns Cancelled when confirm throws", async () => {
    const decision = await approveOrDeny("Allow this web fetch?", "https://example.com", {
      hasUI: true,
      confirm: async () => {
        throw new Error("boom");
      },
    });
    expect(decision).toEqual({ ok: false, text: "Cancelled" });
  });

  it("returns Cancelled when aborted before confirm", async () => {
    const confirm = vi.fn(async () => true);
    const signal = AbortSignal.abort();
    const decision = await approveOrDeny("Allow this web fetch?", "https://example.com", {
      hasUI: true,
      confirm,
      signal,
    });
    expect(decision).toEqual({ ok: false, text: "Cancelled" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns Cancelled when aborted after confirm resolves true", async () => {
    const controller = new AbortController();
    const confirm = vi.fn(async () => {
      controller.abort();
      return true;
    });
    const decision = await approveOrDeny("Allow this web fetch?", "https://example.com", {
      hasUI: true,
      confirm,
      signal: controller.signal,
    });
    expect(decision).toEqual({ ok: false, text: "Cancelled" });
  });
});
