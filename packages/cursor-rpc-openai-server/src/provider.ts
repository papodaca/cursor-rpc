import type { ClientRunOptions, CursorRpcClient, RunHandle } from "cursor-rpc";

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

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}
