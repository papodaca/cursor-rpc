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
    lastInputs = settings;
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
      lastOptions = undefined;
    },
  };
}

function resolvedClientOptions(settings: CursorProviderSettings): CreateClientOptions {
  const options: CreateClientOptions = {};
  if (settings.apiKey !== undefined) {
    options.apiKey = settings.apiKey;
  }
  if (settings.fetch !== undefined) {
    options.fetch = settings.fetch;
  }
  if (settings.env !== undefined) {
    options.env = settings.env;
  }
  const headers = sanitizeProviderHeaders(settings.headers);
  if (headers !== undefined) {
    options.headers = headers;
  }
  return options;
}

function sameClientOptions(left: CreateClientOptions, right: CreateClientOptions): boolean {
  return (
    left.apiKey === right.apiKey &&
    left.fetch === right.fetch &&
    left.env === right.env &&
    sameHeaders(left.headers, right.headers)
  );
}

function sameHeaders(left: Headers | undefined, right: Headers | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (left === undefined || right === undefined) {
    return false;
  }
  const leftEntries = [...left.entries()].sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = [...right.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(
    ([name, value], index) => rightEntries[index]?.[0] === name && rightEntries[index]?.[1] === value,
  );
}
