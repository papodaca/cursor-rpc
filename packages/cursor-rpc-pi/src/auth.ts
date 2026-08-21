import {
  AuthenticationError,
  createClient,
  login,
  MemoryCredentialStore,
  type CursorRpcClient,
} from "cursor-rpc";
import { redactSecrets } from "./overflow.js";
import type { ModelAuth, OAuthCredential, ProviderAuthInteraction, SimpleStreamOptions, StoredCredential } from "./types.js";

export type ClientSecret = { apiKey?: string; authToken?: string };
export type ClientFactory = (secret: ClientSecret) => CursorRpcClient;

export class ClientEpoch {
  #client: CursorRpcClient | undefined;
  #fingerprint: string | undefined;
  #factory: ClientFactory;

  constructor(factory?: ClientFactory) {
    this.#factory =
      factory ??
      ((secret) =>
        createClient({
          apiKey: secret.apiKey,
          authToken: secret.authToken,
          store: new MemoryCredentialStore(),
          env: pluginRuntimeEnv(),
        }));
  }

  clientFor(secret: ClientSecret): CursorRpcClient {
    const fingerprint = secret.authToken !== undefined ? `t:${secret.authToken}` : `k:${secret.apiKey ?? ""}`;
    if (this.#client !== undefined && this.#fingerprint === fingerprint) {
      return this.#client;
    }
    this.drop();
    this.#client = this.#factory(secret);
    this.#fingerprint = fingerprint;
    return this.#client;
  }

  drop(): void {
    this.#client?.close();
    this.#client = undefined;
    this.#fingerprint = undefined;
  }
}

export function resolveClientSecret(
  options?: SimpleStreamOptions,
  env: Record<string, string | undefined> = process.env,
): ClientSecret | undefined {
  const envKey = env.CURSOR_API_KEY?.trim();
  if (envKey !== undefined && envKey.length > 0) {
    return { apiKey: envKey };
  }
  const resolved = options?.apiKey?.trim();
  if (resolved === undefined || resolved.length === 0) {
    return undefined;
  }
  return isJwt(resolved) ? { authToken: resolved } : { apiKey: resolved };
}

export function clientForStream(epoch: ClientEpoch, options?: SimpleStreamOptions): CursorRpcClient | undefined {
  const secret = resolveClientSecret(options);
  if (secret === undefined) {
    return undefined;
  }
  return epoch.clientFor(secret);
}

export function pluginRuntimeEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return {
    CURSOR_API_ENDPOINT: env.CURSOR_API_ENDPOINT,
    CURSOR_API_BASE_URL: env.CURSOR_API_BASE_URL,
    CURSOR_WEBSITE_URL: env.CURSOR_WEBSITE_URL,
  };
}

export function dropAfterAuthError(epoch: ClientEpoch, error: unknown): void {
  if (error instanceof AuthenticationError) {
    epoch.drop();
  }
}

export function cursorAuth(deps: { login?: typeof login } = {}): {
  apiKey: {
    name: string;
    resolve: (args: { credential?: { key?: string } }) => Promise<{ auth: { apiKey: string }; source: string } | undefined>;
  };
  oauth: {
    name: string;
    login: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>;
    refresh: (credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>;
    toAuth: (credential: OAuthCredential) => Promise<ModelAuth>;
  };
} {
  const loginFn = deps.login ?? login;
  return {
    apiKey: {
      name: "Cursor API key",
      resolve: async ({ credential }) => {
        const envKey = process.env.CURSOR_API_KEY?.trim();
        if (envKey !== undefined && envKey.length > 0) {
          return { auth: { apiKey: envKey }, source: "CURSOR_API_KEY" };
        }
        const stored = credential?.key?.trim();
        if (stored !== undefined && stored.length > 0) {
          return { auth: { apiKey: stored }, source: "stored API key" };
        }
        return undefined;
      },
    },
    oauth: {
      name: "Cursor",
      login: async (interaction) => {
        try {
          const session = loginFn();
          interaction.notify({ type: "auth_url", url: session.url });
          if (session.url.includes("verifier=")) {
            throw new Error("authorization URL must not include poll verifier");
          }
          const tokens = await session.wait(interaction.signal);
          return {
            type: "oauth",
            refresh: tokens.refreshToken ?? "",
            access: tokens.accessToken,
            expires: Date.now() + 24 * 60 * 60 * 1000,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(redactSecrets(message));
        }
      },
      refresh: async (credential) => credential,
      toAuth: async (credential) => ({ apiKey: credential.access }),
    },
  };
}

function isJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts[0] !== undefined && parts[0].startsWith("eyJ");
}

export function isOauthCredential(credential: StoredCredential): credential is Extract<StoredCredential, { access: string }> {
  return credential !== undefined && "access" in credential && typeof credential.access === "string";
}
