import { Code, ConnectError } from "@connectrpc/connect";
import { AuthenticationError, CursorRpcError } from "../errors.js";
import type { CredentialStore, StoredCredentials } from "../credentials.js";
import { exchangeApiKey, type FetchLike } from "./api-key.js";
import { isExpiringSoon } from "./token.js";

export type AuthOptions = {
  apiUrl: string;
  store: CredentialStore;
  authToken?: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  signal?: AbortSignal;
};

export class AuthSession {
  readonly store: CredentialStore;
  #pinned = false;
  #constructorApiKey: string | undefined;
  #rawToken: boolean;
  #apiUrl: string;
  #fetch: FetchLike | undefined;
  #ephemeralAccessToken: string | undefined;

  constructor(options: AuthOptions) {
    this.store = options.store;
    this.#apiUrl = options.apiUrl;
    this.#fetch = options.fetch;
    const env = options.env ?? process.env;
    const authToken = first(options.authToken, env.CURSOR_AUTH_TOKEN);
    this.#constructorApiKey = first(options.apiKey, env.CURSOR_API_KEY);
    this.#rawToken = authToken !== undefined;
    if (authToken !== undefined) {
      this.store.save({ accessToken: authToken, refreshToken: authToken });
    } else if (this.#constructorApiKey !== undefined) {
      const existing = snapshot(this.store.load());
      this.store.save({ ...existing, apiKey: this.#constructorApiKey });
    }
  }

  get pinned(): boolean {
    return this.#pinned;
  }

  async accessToken(signal?: AbortSignal): Promise<string> {
    if (this.#pinned) {
      throw new AuthenticationError("invalid token, please log in again");
    }
    const loaded = await Promise.resolve(this.store.load());
    const credentials = loaded ?? {};
    if (credentials.accessToken !== undefined && !isExpiringSoon(credentials.accessToken)) {
      return credentials.accessToken;
    }
    if (
      this.#ephemeralAccessToken !== undefined &&
      !isExpiringSoon(this.#ephemeralAccessToken) &&
      credentials.accessToken === undefined
    ) {
      return this.#ephemeralAccessToken;
    }
    const apiKey = this.#rawToken || this.#pinned ? undefined : (credentials.apiKey ?? this.#constructorApiKey);
    if (apiKey !== undefined) {
      const pair = await exchangeApiKey(this.#apiUrl, apiKey, { fetch: this.#fetch, signal });
      this.#ephemeralAccessToken = pair.accessToken;
      await Promise.resolve(this.store.save({ ...credentials, ...pair, apiKey }));
      return pair.accessToken;
    }
    if (credentials.accessToken !== undefined) {
      return credentials.accessToken;
    }
    throw new AuthenticationError("authentication required");
  }

  handleAuthFailure(error: unknown, bearerWasSent: boolean): boolean {
    if (!isAuthFailure(error, bearerWasSent)) {
      return false;
    }
    try {
      this.store.clear();
    } catch {
      // Clearing must not itself throw.
    }
    this.#pinned = true;
    this.#ephemeralAccessToken = undefined;
    return true;
  }
}

export function isAuthFailure(error: unknown, bearerWasSent: boolean): boolean {
  if (error instanceof ConnectError) {
    return error.code === Code.Unauthenticated;
  }
  if (error instanceof CursorRpcError && error.code === "unauthenticated") {
    return true;
  }
  if (!bearerWasSent) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  return (
    lowered.includes("401") ||
    lowered.includes("unauthorized") ||
    lowered.includes("unauthenticated") ||
    lowered.includes("authentication failed") ||
    lowered.includes("invalid token") ||
    lowered.includes("token expired")
  );
}

function first(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function snapshot(value: StoredCredentials | undefined | Promise<StoredCredentials | undefined>): StoredCredentials {
  if (value instanceof Promise) {
    return {};
  }
  return value ?? {};
}
