import {
  createClient as defaultCreateClient,
  type CreateClientOptions,
  type CursorRpcClient,
  type ModelDetails,
} from "cursor-rpc";
import { sanitizeProviderHeaders } from "./headers.js";
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
  options?: {
    apiKey?: string;
    env?: Record<string, string | undefined>;
    fetch?: CreateClientOptions["fetch"];
    headers?: Headers | Record<string, string>;
  };
  settings?: {
    apiKey?: string;
    env?: Record<string, string | undefined>;
    fetch?: CreateClientOptions["fetch"];
    headers?: Headers | Record<string, string>;
  };
  models?: Record<string, OpenCodeModelRow | { name?: string; tool_call?: boolean }>;
};

export type OpenCodeConfig = {
  provider?: { cursor?: OpenCodeProviderBlock };
  providers?: { cursor?: OpenCodeProviderBlock };
};

export type CatalogueOverlayOptions = {
  apiKey?: string;
  env?: Record<string, string | undefined>;
  fetch?: CreateClientOptions["fetch"];
  headers?: Headers | Record<string, string>;
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

export const cursorPlugin = {
  name: "cursor-rpc",
  config: overlayCursorCatalogue,
};

export { cursorPlugin as plugin };

async function overlayOrKeepSeed(cfg: OpenCodeConfig, options: CatalogueOverlayOptions): Promise<void> {
  const env = resolveEnv(cfg, options);
  const apiKey = resolveApiKey(cfg, options);
  if (!hasOverlayCredentials(apiKey, env)) {
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
    const name = nonEmpty(model.displayName)
      ? model.displayName
      : nonEmpty(model.displayNameShort)
        ? model.displayNameShort
        : id;
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
  cfg.provider ??= {};
  cfg.provider.cursor ??= {};
  cfg.provider.cursor.models = rows;
  if (cfg.providers?.cursor !== undefined) {
    cfg.providers.cursor.models = rows;
  }
}

function cursorBlocks(cfg: OpenCodeConfig): OpenCodeProviderBlock[] {
  const blocks: OpenCodeProviderBlock[] = [];
  if (cfg.provider?.cursor !== undefined) {
    blocks.push(cfg.provider.cursor);
  }
  if (cfg.providers?.cursor !== undefined) {
    blocks.push(cfg.providers.cursor);
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
): boolean {
  return nonEmpty(apiKey) || nonEmpty(env.CURSOR_API_KEY) || nonEmpty(env.CURSOR_AUTH_TOKEN);
}

function buildClientOptions(
  cfg: OpenCodeConfig,
  pluginOptions: CatalogueOverlayOptions,
  apiKey: string | undefined,
  env: Record<string, string | undefined>,
): CreateClientOptions {
  const block = cursorBlocks(cfg)[0];
  const settings = block?.options ?? block?.settings;
  const options: CreateClientOptions = { env };
  if (apiKey !== undefined) {
    options.apiKey = apiKey;
  }
  const fetch = pluginOptions.fetch ?? settings?.fetch;
  if (fetch !== undefined) {
    options.fetch = fetch;
  }
  const headers = sanitizeProviderHeaders(pluginOptions.headers ?? settings?.headers);
  if (headers !== undefined) {
    options.headers = headers;
  }
  return options;
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
