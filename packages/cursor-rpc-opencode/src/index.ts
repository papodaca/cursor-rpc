import { createClient, type CreateClientOptions, type CursorRpcClient } from "cursor-rpc";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { resolvedClientOptions, sameSettingsInputs } from "./client-options.js";
import { CursorLanguageModel } from "./language-model.js";

export type CursorProviderSettings = {
  name?: string;
  apiKey?: string;
  authToken?: string;
  credentials?: { accessToken: string; refreshToken: string };
  fetch?: NonNullable<CreateClientOptions["fetch"]>;
  headers?: Headers | Record<string, string>;
  abortSignal?: AbortSignal;
  env?: Record<string, string | undefined>;
  clientType?: string;
  clientVersion?: string;
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
    const created = createClient(resolvedClientOptions(settings));
    client?.close();
    client = created;
    lastInputs = {
      apiKey: settings.apiKey,
      authToken: settings.authToken,
      credentials: settings.credentials,
      fetch: settings.fetch,
      env: settings.env,
      headers: settings.headers,
      clientType: settings.clientType,
      clientVersion: settings.clientVersion,
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
