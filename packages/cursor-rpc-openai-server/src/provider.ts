import { AuthenticationError, createClient, type ClientRunOptions, type CursorRpcClient, type RunHandle } from "cursor-rpc";
import { emptyToUndefined } from "./config.js";

export type CatalogueView = {
  ids: readonly string[];
  defaultId?: string;
  resolve: (id: string) => string | undefined;
};

export type ServerProvider = {
  models: () => Promise<CatalogueView>;
  run: (options: ClientRunOptions) => Promise<RunHandle>;
};

type CatalogueLike = {
  models?: ReadonlyArray<{ modelId?: string }>;
  defaultModel?: { modelId?: string };
  aliasMap?: Map<string, string>;
};

export function catalogueView(catalogue: CatalogueLike): CatalogueView {
  const ids = (catalogue.models ?? [])
    .map((model) => model.modelId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const defaultId = emptyToUndefined(catalogue.defaultModel?.modelId);
  const aliasMap = catalogue.aliasMap ?? new Map(ids.map((id) => [id.toLowerCase(), id] as const));
  return {
    ids,
    ...(defaultId === undefined ? {} : { defaultId }),
    resolve(id: string) {
      return aliasMap.get(id.toLowerCase());
    },
  };
}

export function wrapClient(client: Pick<CursorRpcClient, "models" | "run">): ServerProvider {
  return {
    async models() {
      return catalogueView(await client.models());
    },
    run(options) {
      return client.run(options);
    },
  };
}

export function providerFromEnv(env: Record<string, string | undefined> = process.env): ServerProvider {
  try {
    return wrapClient(createClient({ env }));
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw new Error("CURSOR_API_KEY or CURSOR_AUTH_TOKEN is required to start the server");
    }
    throw error;
  }
}

export function emptyProvider(): ServerProvider {
  return {
    async models() {
      return catalogueView({ models: [] });
    },
    async run() {
      throw new Error("cursor-rpc client was not provided");
    },
  };
}
