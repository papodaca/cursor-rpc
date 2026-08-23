import { createClient, type CreateClientOptions, type CursorRpcClient } from "cursor-rpc";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { resolvedClientOptions, sameSettingsInputs } from "./client-options.js";
import { CursorLanguageModel } from "./language-model.js";

export { TOOLS_SUPPORTED } from "./language-model.js";
export { cursorPlugin, plugin } from "./catalogue.js";

export type CursorProviderSettings = {
  name?: string;
  apiKey?: string;
  fetch?: NonNullable<CreateClientOptions["fetch"]>;
  headers?: Headers | Record<string, string>;
  abortSignal?: AbortSignal;
  env?: Record<string, string | undefined>;
};

export type CursorProvider = {
  languageModel(modelId: string): LanguageModelV3;
  close(): void;
};

export function createCursor(settings: CursorProviderSettings = {}): CursorProvider {
  let client: CursorRpcClient | undefined;
  let lastInputs: CursorProviderSettings | undefined;

  function getClient(): CursorRpcClient {
    if (client !== undefined && lastInputs !== undefined && sameSettingsInputs(lastInputs, settings)) {
      return client;
    }
    client?.close();
    const created = createClient(resolvedClientOptions(settings));
    client = created;
    lastInputs = {
      apiKey: settings.apiKey,
      fetch: settings.fetch,
      env: settings.env,
      headers: settings.headers,
    };
    return created;
  }

  return {
    languageModel(modelId: string): LanguageModelV3 {
      return new CursorLanguageModel({
        modelId,
        provider: settings.name ?? "cursor-rpc",
        getClient,
      });
    },
    close(): void {
      client?.close();
      client = undefined;
      lastInputs = undefined;
    },
  };
}
