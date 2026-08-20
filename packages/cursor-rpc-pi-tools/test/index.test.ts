import { describe, expect, it, vi } from "vitest";
import { createExtension } from "../src/index.ts";
import type { WebClient } from "cursor-rpc";

describe("extension factory", () => {
  it("registers web_fetch and web_search and closes the client on shutdown", () => {
    const close = vi.fn();
    const client = {
      fetch: vi.fn(),
      search: vi.fn(),
      close,
    } as unknown as WebClient;
    const registered: string[] = [];
    const handlers: Array<() => void> = [];
    const pi = {
      registerTool: (tool: { name: string }) => {
        registered.push(tool.name);
      },
      on: (event: string, handler: () => void) => {
        if (event === "session_shutdown") {
          handlers.push(handler);
        }
      },
    };
    createExtension({ client })(pi as never);
    expect(registered.sort()).toEqual(["web_fetch", "web_search"]);
    for (const handler of handlers) {
      handler();
    }
    expect(close).toHaveBeenCalledOnce();
  });
});
