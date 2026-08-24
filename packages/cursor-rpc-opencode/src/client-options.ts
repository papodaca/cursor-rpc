import type { CreateClientOptions } from "cursor-rpc";
import { sanitizeProviderHeaders } from "./headers.js";

const FORWARDED_ENV_KEYS = ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] as const;

/** Agent Run uses the CLI identity. Library default `private_worker` is a different product pool. */
const OPENCODE_CLIENT_TYPE = "cli";
const OPENCODE_CLIENT_VERSION = "cli-1.0.0";

export type ProviderClientSettings = {
  apiKey?: string;
  authToken?: string;
  credentials?: { accessToken: string; refreshToken: string };
  fetch?: NonNullable<CreateClientOptions["fetch"]>;
  env?: Record<string, string | undefined>;
  headers?: Headers | Record<string, string>;
  clientType?: string;
  clientVersion?: string;
};

export function resolvedClientOptions(settings: ProviderClientSettings): CreateClientOptions {
  const options: CreateClientOptions = {
    clientType: settings.clientType ?? OPENCODE_CLIENT_TYPE,
    clientVersion: settings.clientVersion ?? OPENCODE_CLIENT_VERSION,
  };
  if (settings.credentials !== undefined) {
    options.credentials = settings.credentials;
  } else if (settings.apiKey !== undefined) {
    options.apiKey = settings.apiKey;
  }
  if (settings.authToken !== undefined) {
    options.authToken = settings.authToken;
  }
  if (settings.fetch !== undefined) {
    options.fetch = settings.fetch;
  }
  if (settings.env !== undefined) {
    options.env = allowlistedEnv(settings.env);
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
    left.authToken === right.authToken &&
    left.credentials?.accessToken === right.credentials?.accessToken &&
    left.credentials?.refreshToken === right.credentials?.refreshToken &&
    left.fetch === right.fetch &&
    left.env === right.env &&
    left.headers === right.headers &&
    left.clientType === right.clientType &&
    left.clientVersion === right.clientVersion
  );
}

function allowlistedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const allowed: Record<string, string | undefined> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    if (key in env) {
      allowed[key] = env[key];
    }
  }
  return allowed;
}
