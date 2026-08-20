import { CursorRpcError } from "../errors.js";
import type { AvailableModel, GetDefaultModelForCliResponse, GetUsableModelsResponse, ModelDetails } from "../generated/aiserver/v1/models_pb.js";

const PARAMETERIZED_EXCLUSIONS = new Set([
  "claude-4.5-haiku",
  "claude-4.5-haiku-thinking",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
]);

export type ModelCatalogue = {
  models: ModelDetails[];
  defaultModel?: ModelDetails;
  parameterizedModels?: AvailableModel[];
  parameterizedModelsFetchStatus?: "timed_out";
  aliasMap: Map<string, string>;
};

export function mergeModelCatalogue(
  usable: GetUsableModelsResponse | Error,
  defaultModel: GetDefaultModelForCliResponse | Error | undefined,
  parameterized: AvailableModel[] | "timed_out" | Error | undefined,
): ModelCatalogue {
  if (usable instanceof Error) {
    throw usable;
  }
  if (usable.models.length === 0) {
    throw new CursorRpcError("usable models list is empty", { code: "failed_precondition" });
  }
  const models = usable.models;
  const aliasMap = buildAliasMap(models);
  const catalogue: ModelCatalogue = { models, aliasMap };
  if (defaultModel !== undefined && !(defaultModel instanceof Error)) {
    catalogue.defaultModel = defaultModel.model;
  }
  if (parameterized === "timed_out") {
    catalogue.parameterizedModelsFetchStatus = "timed_out";
    return catalogue;
  }
  if (Array.isArray(parameterized)) {
    const filtered = filterParameterized(parameterized);
    if (filtered !== undefined) {
      catalogue.parameterizedModels = filtered;
    }
  }
  return catalogue;
}

export function buildAliasMap(models: ModelDetails[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const model of models) {
    const id = model.modelId;
    if (id.length === 0) {
      continue;
    }
    map.set(id.toLowerCase(), id);
    for (const alias of model.aliases) {
      map.set(alias.toLowerCase(), id);
    }
    if (model.displayModelId.length > 0) {
      map.set(model.displayModelId.toLowerCase(), id);
    }
    if (model.displayName.length > 0) {
      map.set(model.displayName.toLowerCase(), id);
    }
    if (model.displayNameShort.length > 0) {
      map.set(model.displayNameShort.toLowerCase(), id);
    }
  }
  return map;
}

export function filterParameterized(models: AvailableModel[]): AvailableModel[] | undefined {
  const kept = models.filter((model) => !PARAMETERIZED_EXCLUSIONS.has(model.name));
  const useful = kept.some(
    (model) => model.parameterDefinitions.length > 0 || model.variants.length > 0,
  );
  return useful ? kept : undefined;
}

export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T | "timed_out"> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const workPromise = work(controller.signal);
  void workPromise.catch(() => undefined);
  try {
    return await Promise.race<T | "timed_out">([
      workPromise.then(
        (value): T | "timed_out" => (timedOut ? "timed_out" : value),
        (error: unknown): T | "timed_out" => {
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
