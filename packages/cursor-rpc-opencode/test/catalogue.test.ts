import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CursorRpcClient, ModelCatalogue, ModelDetails, RunHandle } from "cursor-rpc";
import { createClient, login } from "cursor-rpc";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLS_SUPPORTED } from "../src/language-model.ts";
import { plugin as cursorPlugin } from "../src/plugin.ts";

vi.mock("cursor-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("cursor-rpc")>();
  return {
    ...actual,
    createClient: vi.fn((options: Parameters<typeof actual.createClient>[0]) => actual.createClient(options)),
    login: vi.fn(() => {
      throw new Error("login must not be called");
    }),
  };
});

const SEED_ID = "composer-2.5";

function unusedHandle(): RunHandle {
  return {
    async *[Symbol.asyncIterator]() {
      throw new Error("run must not be called");
    },
    wait: async () => {
      throw new Error("run must not be called");
    },
    abort: () => undefined,
    conversationHistory: () => ({ messages: [] }) as ReturnType<RunHandle["conversationHistory"]>,
  };
}

function catalogueModel(partial: {
  modelId: string;
  displayName?: string;
  displayNameShort?: string;
  displayModelId?: string;
  aliases?: string[];
}): ModelDetails {
  return {
    modelId: partial.modelId,
    displayModelId: partial.displayModelId ?? "",
    displayName: partial.displayName ?? "",
    displayNameShort: partial.displayNameShort ?? "",
    aliases: partial.aliases ?? [],
    credentials: { case: undefined },
  } as ModelDetails;
}

function fakeClient(catalogue: ModelCatalogue | (() => Promise<ModelCatalogue>)): CursorRpcClient {
  return {
    close: () => undefined,
    run: async () => unusedHandle(),
    models: async () => (typeof catalogue === "function" ? catalogue() : catalogue),
  };
}

function seedConfig() {
  return {
    provider: {
      cursor: {
        npm: "file:///absolute/path/to/packages/cursor-rpc-opencode",
        models: {
          [SEED_ID]: {
            name: "Composer 2.5",
            tool_call: true,
          },
        },
      },
    },
  };
}

describe("cursorPlugin catalogue overlay", () => {
  beforeEach(() => {
    vi.mocked(createClient).mockReset();
    vi.mocked(login).mockClear();
  });

  it("exports a function plugin (not create*) and createCursor remains the only create* export", async () => {
    const factory = await import("../src/index.ts");
    const pluginMod = await import("../src/plugin.ts");
    expect(typeof pluginMod.plugin).toBe("function");
    expect(pluginMod.plugin.name.startsWith("create")).toBe(false);
    expect(pluginMod.plugin()).toEqual({ config: expect.any(Function) });
    expect("plugin" in factory).toBe(false);
    const createKeys = Object.keys(factory).filter((key) => key.startsWith("create"));
    expect(createKeys).toEqual(["createCursor"]);
  });

  it("replaces the seed with usable live catalogue ids", async () => {
    vi.mocked(createClient).mockImplementation(() =>
      fakeClient({
        models: [
          catalogueModel({ modelId: "gpt-5", displayName: "GPT-5" }),
          catalogueModel({ modelId: "claude-4-sonnet", displayName: "Claude 4 Sonnet" }),
        ],
        aliasMap: new Map(),
        parameterizedModels: [
          { name: "parameterized-variant", parameterDefinitions: [], variants: [] } as never,
        ],
      }),
    );
    const cfg = seedConfig();
    const result = await cursorPlugin().config(cfg, { apiKey: "key_ok", env: {} });
    expect(result.provider?.cursor?.models).toEqual({
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        tool_call: TOOLS_SUPPORTED,
        reasoning: true,
        attachment: false,
        capabilities: { tools: TOOLS_SUPPORTED },
      },
      "claude-4-sonnet": {
        id: "claude-4-sonnet",
        name: "Claude 4 Sonnet",
        tool_call: TOOLS_SUPPORTED,
        reasoning: true,
        attachment: false,
        capabilities: { tools: TOOLS_SUPPORTED },
      },
    });
    expect(result.provider?.cursor?.models?.[SEED_ID]).toBeUndefined();
    expect(login).not.toHaveBeenCalled();
  });

  it("uses canonical modelId as the OpenCode id, not alias or display name", async () => {
    vi.mocked(createClient).mockImplementation(() =>
      fakeClient({
        models: [
          catalogueModel({
            modelId: "composer-2",
            displayName: "Composer",
            displayNameShort: "Comp",
            displayModelId: "composer-latest",
            aliases: ["composer", "composer-alias"],
          }),
        ],
        aliasMap: new Map([
          ["composer", "composer-2"],
          ["composer-alias", "composer-2"],
          ["composer-latest", "composer-2"],
        ]),
      }),
    );
    const result = await cursorPlugin().config(seedConfig(), { apiKey: "key_ok", env: {} });
    const models = result.provider?.cursor?.models ?? {};
    expect(Object.keys(models)).toEqual(["composer-2"]);
    expect(models.composer).toBeUndefined();
    expect(models.Composer).toBeUndefined();
    expect(models["composer-latest"]).toBeUndefined();
    expect(models["composer-alias"]).toBeUndefined();
    expect(models["composer-2"]?.name).toBe("Composer");
  });

  it("leaves the seed in place when credentials are missing", async () => {
    const cfg = seedConfig();
    const result = await cursorPlugin().config(cfg, { env: {} });
    expect(result.provider?.cursor?.models?.[SEED_ID]).toEqual({
      name: "Composer 2.5",
      tool_call: true,
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it("keeps the seed and does not throw when models() fails", async () => {
    vi.mocked(createClient).mockImplementation(() =>
      fakeClient(async () => {
        throw new Error("transport timeout");
      }),
    );
    const cfg = seedConfig();
    await expect(cursorPlugin().config(cfg, { apiKey: "key_ok", env: {} })).resolves.toBe(cfg);
    expect(cfg.provider.cursor.models[SEED_ID]).toEqual({
      name: "Composer 2.5",
      tool_call: true,
    });
    expect(login).not.toHaveBeenCalled();
  });

  it("keeps the seed when the live catalogue is empty", async () => {
    vi.mocked(createClient).mockImplementation(() => fakeClient({ models: [], aliasMap: new Map() }));
    const cfg = seedConfig();
    const result = await cursorPlugin().config(cfg, { env: { CURSOR_API_KEY: "key_ok" } });
    expect(result.provider?.cursor?.models?.[SEED_ID]).toBeDefined();
    expect(login).not.toHaveBeenCalled();
  });

  it("does not invent a cursor provider when overlay fails and config omitted one", async () => {
    vi.mocked(createClient).mockImplementation(() => {
      throw new Error("authentication required");
    });
    const cfg = {};
    const result = await cursorPlugin().config(cfg, { apiKey: "key_ok", env: {} });
    expect(result.provider).toBeUndefined();
    expect(login).not.toHaveBeenCalled();
  });

  it("sets tool_call and capabilities.tools from TOOLS_SUPPORTED with reasoning and no attachments", async () => {
    expect(TOOLS_SUPPORTED).toBe(true);
    vi.mocked(createClient).mockImplementation(() =>
      fakeClient({
        models: [catalogueModel({ modelId: "gpt-5", displayNameShort: "G5" })],
        aliasMap: new Map(),
      }),
    );
    const result = await cursorPlugin().config(seedConfig(), { apiKey: "key_ok", env: {} });
    expect(result.provider?.cursor?.models?.["gpt-5"]).toEqual({
      id: "gpt-5",
      name: "G5",
      tool_call: true,
      reasoning: true,
      attachment: false,
      capabilities: { tools: true },
    });
  });

  it("overlays a cursor-rpc provider key whose npm points at this package", async () => {
    vi.mocked(createClient).mockImplementation(() =>
      fakeClient({
        models: [catalogueModel({ modelId: "gpt-5", displayName: "GPT-5" })],
        aliasMap: new Map(),
      }),
    );
    const cfg = {
      provider: {
        "cursor-rpc": {
          npm: "file:///absolute/path/to/packages/cursor-rpc-opencode",
          models: {
            [SEED_ID]: { name: "Composer 2.5", tool_call: true },
          },
        },
        cursor: {
          npm: "cursor-opencode-provider",
          models: {},
        },
      },
    };
    const result = await cursorPlugin().config(cfg, { apiKey: "key_ok", env: {} });
    expect(result.provider?.["cursor-rpc"]?.models).toEqual({
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        tool_call: TOOLS_SUPPORTED,
        reasoning: true,
        attachment: false,
        capabilities: { tools: TOOLS_SUPPORTED },
      },
    });
    expect(result.provider?.cursor?.models).toEqual({});
  });
});

describe("README install docs", () => {
  it("documents v1 and v2 file:// install with a seed and empty-models warning", async () => {
    const readme = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../README.md"), "utf8");
    expect(readme).toContain("file://");
    expect(readme).toContain('"plugin"');
    expect(readme).toContain("plugin.js");
    expect(readme).toContain('"plugins"');
    expect(readme).toContain('"npm"');
    expect(readme).toContain('"package"');
    expect(readme).toContain('"options"');
    expect(readme).toContain('"settings"');
    expect(readme).toContain("tool_call");
    expect(readme).toContain("capabilities");
    expect(readme).toContain("tools");
    expect(readme).toContain("composer-2.5");
    expect(readme).toMatch(/empty.*models|models.*empty/i);
    expect(readme).toContain("CURSOR_API_KEY");
    expect(readme).toContain("CURSOR_AUTH_TOKEN");
    expect(readme).toMatch(/Node\.?js 22|Node >=22|node.{0,8}22/i);
    expect(readme).toContain("npm run build -w cursor-rpc-opencode");
    expect(readme).toMatch(/OpenCode owns/i);
    expect(readme).toMatch(/fail-closed|fail closed/i);
    expect(readme).not.toMatch(/npm link/);
    expect(readme).not.toContain("~/.local/share/opencode");
    expect(readme).toMatch(/never opens a browser|interactive authentication/i);
  });
});
