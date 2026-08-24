import {
  createClient as defaultCreateClient,
  type CreateClientOptions,
  type CursorRpcClient,
  type ModelDetails,
} from "cursor-rpc";
import { resolvedClientOptions, type ProviderClientSettings } from "./client-options.js";
import { TOOLS_SUPPORTED } from "./language-model.js";

export type OpenCodeModelRow = {
  id?: string;
  name: string;
  tool_call: boolean;
  reasoning: boolean;
  attachment: boolean;
  capabilities: { tools: boolean };
};

export type OpenCodeProviderBlock = {
  npm?: string;
  package?: string;
  name?: string;
  options?: ProviderClientSettings;
  settings?: ProviderClientSettings;
  models?: Record<string, Partial<OpenCodeModelRow>>;
};

export type OpenCodeConfig = {
  provider?: Record<string, OpenCodeProviderBlock | undefined>;
  providers?: Record<string, OpenCodeProviderBlock | undefined>;
};

export type CatalogueOverlayOptions = ProviderClientSettings & {
  createClient?: typeof defaultCreateClient;
  modelsTimeoutMs?: number;
};

const DEFAULT_MODELS_TIMEOUT_MS = 10_000;

export async function overlayCursorCatalogue(
  cfg: OpenCodeConfig,
  options: CatalogueOverlayOptions = {},
): Promise<OpenCodeConfig> {
  try {
    await overlayOrKeepSeed(cfg, options);
  } catch {
    // Auth, empty catalogue, transport, or timeout: keep the static seed.
  }
  return cfg;
}

async function overlayOrKeepSeed(cfg: OpenCodeConfig, options: CatalogueOverlayOptions): Promise<void> {
  const env = resolveEnv(cfg, options);
  const apiKey = resolveApiKey(cfg, options);
  if (!hasOverlayCredentials(apiKey, env, options)) {
    return;
  }

  const createClient = options.createClient ?? defaultCreateClient;
  let client: CursorRpcClient | undefined;
  try {
    client = createClient(buildClientOptions(cfg, options, apiKey, env));
    const catalogue = await modelsWithTimeout(client, options.modelsTimeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS);
    if (catalogue === "timed_out") {
      return;
    }
    const rows = usableRows(catalogue.models);
    if (Object.keys(rows).length === 0) {
      return;
    }
    replaceModels(cfg, rows);
  } finally {
    try {
      client?.close();
    } catch {
      // Dispose is best-effort; overlay must not throw.
    }
  }
}

function usableRows(models: ModelDetails[] | undefined): Record<string, OpenCodeModelRow> {
  const rows: Record<string, OpenCodeModelRow> = {};
  if (models === undefined) {
    return rows;
  }
  for (const model of models) {
    const id = model.modelId.trim();
    if (id.length === 0) {
      continue;
    }
    const name = modelRowName(model, id);
    rows[id] = {
      id,
      name,
      tool_call: TOOLS_SUPPORTED,
      reasoning: true,
      attachment: false,
      capabilities: { tools: TOOLS_SUPPORTED },
    };
  }
  return rows;
}

function replaceModels(cfg: OpenCodeConfig, rows: Record<string, OpenCodeModelRow>): void {
  for (const block of cursorBlocks(cfg)) {
    block.models = rows;
  }
}

function isOurProviderBlock(block: OpenCodeProviderBlock): boolean {
  const spec = `${block.npm ?? ""} ${block.package ?? ""}`;
  return spec.includes("cursor-rpc-opencode");
}

function cursorBlocks(cfg: OpenCodeConfig): OpenCodeProviderBlock[] {
  const blocks: OpenCodeProviderBlock[] = [];
  for (const group of [cfg.provider, cfg.providers]) {
    if (group === undefined) {
      continue;
    }
    for (const block of Object.values(group)) {
      if (block !== undefined && isOurProviderBlock(block)) {
        blocks.push(block);
      }
    }
  }
  return blocks;
}

function resolveApiKey(cfg: OpenCodeConfig, options: CatalogueOverlayOptions): string | undefined {
  if (nonEmpty(options.apiKey)) {
    return options.apiKey;
  }
  for (const block of cursorBlocks(cfg)) {
    const key = block.options?.apiKey ?? block.settings?.apiKey;
    if (nonEmpty(key)) {
      return key;
    }
  }
  return undefined;
}

function resolveEnv(
  cfg: OpenCodeConfig,
  options: CatalogueOverlayOptions,
): Record<string, string | undefined> {
  if (options.env !== undefined) {
    return options.env;
  }
  for (const block of cursorBlocks(cfg)) {
    const env = block.options?.env ?? block.settings?.env;
    if (env !== undefined) {
      return env;
    }
  }
  return process.env;
}

function hasOverlayCredentials(
  apiKey: string | undefined,
  env: Record<string, string | undefined>,
  options: CatalogueOverlayOptions = {},
): boolean {
  return (
    nonEmpty(apiKey) ||
    nonEmpty(options.authToken) ||
    nonEmpty(options.credentials?.accessToken) ||
    nonEmpty(env.CURSOR_API_KEY) ||
    nonEmpty(env.CURSOR_AUTH_TOKEN)
  );
}

function modelRowName(model: ModelDetails, id: string): string {
  if (nonEmpty(model.displayName)) {
    return model.displayName;
  }
  if (nonEmpty(model.displayNameShort)) {
    return model.displayNameShort;
  }
  return id;
}

function buildClientOptions(
  cfg: OpenCodeConfig,
  pluginOptions: CatalogueOverlayOptions,
  apiKey: string | undefined,
  env: Record<string, string | undefined>,
): CreateClientOptions {
  const block = cursorBlocks(cfg)[0];
  const settings = block?.options ?? block?.settings;
  return resolvedClientOptions({
    env,
    apiKey,
    authToken: pluginOptions.authToken ?? settings?.authToken,
    credentials: pluginOptions.credentials ?? settings?.credentials,
    fetch: pluginOptions.fetch ?? settings?.fetch,
    headers: pluginOptions.headers ?? settings?.headers,
  });
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

async function modelsWithTimeout(
  client: CursorRpcClient,
  timeoutMs: number,
): Promise<Awaited<ReturnType<CursorRpcClient["models"]>> | "timed_out"> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = client.models(controller.signal);
  void work.catch(() => undefined);
  try {
    return await Promise.race([
      work.then(
        (value): Awaited<ReturnType<CursorRpcClient["models"]>> | "timed_out" =>
          timedOut ? "timed_out" : value,
        (error: unknown): Awaited<ReturnType<CursorRpcClient["models"]>> | "timed_out" => {
          if (timedOut || controller.signal.aborted) {
            return "timed_out";
          }
          throw error;
        },
      ),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve("timed_out");
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
