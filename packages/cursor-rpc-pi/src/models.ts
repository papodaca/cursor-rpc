import { AuthenticationError, type ModelCatalogue } from "cursor-rpc";
import { CURSOR_API, PROVIDER_ID } from "./constants.js";
import type { PiModel } from "./types.js";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

export type UsableModel = {
  modelId: string;
  displayName: string;
  thinkingDetails?: unknown;
};

export function toPiModels(catalogue: { models: UsableModel[] } | ModelCatalogue): PiModel[] {
  return catalogue.models
    .filter((model) => {
      const id = model.modelId.toLowerCase();
      return model.modelId.length > 0 && id !== "auto" && id !== "default";
    })
    .map((model) => ({
      id: model.modelId,
      name: model.displayName.length > 0 ? model.displayName : model.modelId,
      provider: PROVIDER_ID,
      api: CURSOR_API,
      reasoning: model.thinkingDetails !== undefined,
      input: ["text"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    }));
}

export async function fetchCursorModels(
  models: (signal?: AbortSignal) => Promise<ModelCatalogue>,
  signal?: AbortSignal,
): Promise<PiModel[]> {
  if (signal?.aborted) {
    return [];
  }
  try {
    return toPiModels(await models(signal));
  } catch (error) {
    if (signal?.aborted) {
      return [];
    }
    if (error instanceof AuthenticationError) {
      return [];
    }
    throw error;
  }
}
