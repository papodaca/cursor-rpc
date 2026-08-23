import type { CreateClientOptions } from "cursor-rpc";
import { sanitizeProviderHeaders } from "./headers.js";

export type ProviderClientSettings = {
  apiKey?: string;
  fetch?: NonNullable<CreateClientOptions["fetch"]>;
  env?: Record<string, string | undefined>;
  headers?: Headers | Record<string, string>;
};

export function resolvedClientOptions(settings: ProviderClientSettings): CreateClientOptions {
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

export function sameSettingsInputs(left: ProviderClientSettings, right: ProviderClientSettings): boolean {
  return (
    left.apiKey === right.apiKey &&
    left.fetch === right.fetch &&
    left.env === right.env &&
    left.headers === right.headers
  );
}
