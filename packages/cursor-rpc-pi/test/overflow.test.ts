import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { overflowHandler, redactSecrets } from "../src/overflow.ts";
import { PROVIDER_ID } from "../src/constants.ts";
import type { PiAssistantMessage } from "../src/types.ts";
import { TEST_MODEL } from "./helpers.ts";

function assistant(errorMessage: string, provider = PROVIDER_ID): PiAssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: TEST_MODEL.api,
    provider,
    model: TEST_MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    timestamp: 1,
    errorMessage,
  };
}

describe("overflow rewrite", () => {
  it("rewrites context-limit errors, leaves rate limits, and is idempotent", () => {
    const rewritten = overflowHandler({ message: assistant("prompt is too long for the context window") }, { model: TEST_MODEL });
    expect(rewritten?.message.errorMessage).toMatch(/^context_length_exceeded:/);
    const again = overflowHandler({ message: rewritten!.message }, { model: TEST_MODEL });
    expect(again?.message.errorMessage).toBe(rewritten?.message.errorMessage);
    expect(overflowHandler({ message: assistant("rate limit 429 too many requests") }, { model: TEST_MODEL })).toBeUndefined();
  });

  it("does not rewrite other providers", () => {
    expect(
      overflowHandler({ message: assistant("prompt is too long", "openai") }, { model: { ...TEST_MODEL, provider: "openai" } }),
    ).toBeUndefined();
  });

  it("does not rewrite auth, stall, or HTTP/1.1 errors", () => {
    expect(overflowHandler({ message: assistant("unauthenticated expired") }, { model: TEST_MODEL })).toBeUndefined();
    expect(overflowHandler({ message: assistant("stall_detector deadline_exceeded") }, { model: TEST_MODEL })).toBeUndefined();
    expect(overflowHandler({ message: assistant("HTTP/1.1 is unsupported") }, { model: TEST_MODEL })).toBeUndefined();
  });

  it("redacts Bearer and verifier from rewritten overflow text", () => {
    const rewritten = overflowHandler(
      {
        message: assistant(
          "maximum context exceeded cause Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.sig verifier=secret-poll",
        ),
      },
      { model: TEST_MODEL },
    );
    expect(rewritten?.message.errorMessage).toMatch(/^context_length_exceeded:/);
    expect(rewritten?.message.errorMessage).not.toContain("Bearer ");
    expect(rewritten?.message.errorMessage).not.toContain("verifier=");
    expect(redactSecrets("Bearer abc verifier=xyz")).toBe("[redacted] [redacted]");
  });

  it("README uses placeholders and states turn data is sent to Cursor", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    expect(readme).toContain("cursor-rpc");
    expect(readme).toContain("cursor-connectrpc");
    expect(readme).toContain("@cursor/sdk");
    expect(readme).toContain("pi install npm:cursor-rpc-pi");
    expect(readme).toContain("/login cursor-rpc");
    expect(readme).toMatch(/prompts, tool schemas, and tool results are sent to Cursor/i);
    expect(readme).not.toMatch(/key_live_[A-Za-z0-9]+/);
    expect(readme).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
  });
});
