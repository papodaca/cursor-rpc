import { emptyToUndefined } from "../config.js";
import { openaiError, type OpenAIErrorBody } from "../errors.js";
import type { CatalogueView } from "../provider.js";

export type OpenAIModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: "cursor";
};

export function toOpenAIModel(id: string): OpenAIModel {
  return {
    id,
    object: "model",
    created: 0,
    owned_by: "cursor",
  };
}

export function listModelsResponse(catalogue: CatalogueView): { object: "list"; data: OpenAIModel[] } {
  return {
    object: "list",
    data: catalogue.ids.map(toOpenAIModel),
  };
}

export function resolveCreateModel(catalogue: CatalogueView, model: string | undefined): string | undefined {
  const requested = emptyToUndefined(model);
  if (requested === undefined) {
    return catalogue.defaultId ?? catalogue.ids[0];
  }
  return catalogue.resolve(requested);
}

export function modelNotFoundError(model: string | undefined): OpenAIErrorBody {
  const label = emptyToUndefined(model) ?? "";
  return openaiError({
    message: label.length === 0 ? "No model available" : `The model \`${label}\` does not exist`,
    type: "invalid_request_error",
    param: "model",
    code: "model_not_found",
  });
}
