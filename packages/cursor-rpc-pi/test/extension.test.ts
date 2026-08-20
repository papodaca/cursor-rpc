import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as cursorRpc from "cursor-rpc";
import loadExtension from "../src/index.ts";
import { CURSOR_API, PROVIDER_ID } from "../src/constants.ts";
import { overflowHandler } from "../src/overflow.ts";
import { cursorProviderInput } from "../src/provider.ts";
import type { CreateProviderInput } from "../src/types.ts";

vi.mock("cursor-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cursor-rpc")>();
  return {
    ...actual,
    createClient: vi.fn((options: Parameters<typeof actual.createClient>[0]) => actual.createClient(options)),
  };
});

describe("Pi package registration", () => {
  it("loading the factory registers provider id cursor-rpc with empty models and overflow handler", async () => {
    const registered: CreateProviderInput[] = [];
    const hooks: Array<[string, unknown]> = [];
    await loadExtension({
      registerProvider(provider) {
        registered.push(provider as CreateProviderInput);
      },
      on(event, handler) {
        hooks.push([event, handler]);
        return undefined;
      },
    });
    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe(PROVIDER_ID);
    expect(registered[0]?.models).toEqual([]);
    expect(registered[0]?.api[CURSOR_API]?.streamSimple).toBeTypeOf("function");
    expect(hooks).toEqual([["message_end", overflowHandler]]);
  });

  it("factory promise resolves without calling createClient", async () => {
    vi.mocked(cursorRpc.createClient).mockClear();
    await loadExtension({
      registerProvider() {
        return undefined;
      },
      on() {
        return undefined;
      },
    });
    expect(cursorRpc.createClient).not.toHaveBeenCalled();
  });

  it("provider api on registered models is cursor-connectrpc, not a KnownApi", () => {
    const input = cursorProviderInput();
    expect(Object.keys(input.api)).toEqual([CURSOR_API]);
    expect(CURSOR_API).not.toBe("openai-completions");
    expect(CURSOR_API).not.toBe("anthropic-messages");
  });

  it("package.json peers are *, cursor-rpc is not a peer, and @earendil-works/* is not under dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    expect(manifest.peerDependencies["@earendil-works/pi-ai"]).toBe("*");
    expect(manifest.peerDependencies["@earendil-works/pi-coding-agent"]).toBe("*");
    expect(manifest.peerDependencies["@earendil-works/pi-agent-core"]).toBe("*");
    expect(manifest.peerDependencies["@earendil-works/pi-tui"]).toBe("*");
    expect(manifest.peerDependencies.typebox).toBe("*");
    expect(manifest.dependencies["cursor-rpc"]).toBeDefined();
    expect(manifest.peerDependencies["cursor-rpc"]).toBeUndefined();
    for (const name of Object.keys(manifest.dependencies)) {
      expect(name.startsWith("@earendil-works/")).toBe(false);
    }
  });
});
