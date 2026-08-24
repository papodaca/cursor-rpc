import { login, type TokenPair } from "cursor-rpc";

export type StoredOpenCodeAuth =
  | { type: "oauth"; access?: string; refresh?: string; expires?: number }
  | { type: "api"; key?: string }
  | { type?: string };

export type OpenCodeAuthSuccess =
  | { type: "success"; provider?: string; access: string; refresh: string; expires: number }
  | { type: "success"; provider?: string; key: string };

export type OpenCodeAuthResult = OpenCodeAuthSuccess | { type: "failed" };

export type OpenCodeAuthHook = {
  provider: string;
  loader: (getAuth: () => Promise<StoredOpenCodeAuth | undefined>) => Promise<Record<string, unknown>>;
  methods: Array<
    | {
        type: "oauth";
        label: string;
        authorize: () => Promise<{
          url: string;
          instructions: string;
          method: "auto";
          callback: () => Promise<OpenCodeAuthResult>;
        }>;
      }
    | {
        type: "api";
        label: string;
        prompts: Array<{ type: "text"; key: string; message: string }>;
        authorize: (inputs?: Record<string, string>) => Promise<OpenCodeAuthResult>;
      }
  >;
};

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_AUTH_PROVIDER = "cursor-rpc";

export function cursorAuth(provider: string = DEFAULT_AUTH_PROVIDER): OpenCodeAuthHook {
  return {
    provider,
    loader: loadStoredAuth,
    methods: [
      {
        type: "oauth",
        label: "Login with Cursor",
        async authorize() {
          const pending = login();
          return {
            url: pending.url,
            instructions: "Sign in to Cursor in the browser. Return here when that finishes.",
            method: "auto",
            callback: async () => {
              try {
                return successFromTokens(await pending.wait(), provider);
              } catch {
                return { type: "failed" };
              }
            },
          };
        },
      },
      {
        type: "api",
        label: "Cursor API key",
        prompts: [{ type: "text", key: "api_key", message: "Enter your Cursor API key" }],
        async authorize(inputs = {}) {
          const key = inputs.api_key?.trim();
          if (key === undefined || key.length === 0) {
            return { type: "failed" };
          }
          return { type: "success", key };
        },
      },
    ],
  };
}

export async function loadStoredAuth(
  getAuth: () => Promise<StoredOpenCodeAuth | undefined>,
): Promise<Record<string, unknown>> {
  const info = await getAuth();
  if (info?.type === "api") {
    const key = "key" in info ? info.key : undefined;
    if (nonEmpty(key)) {
      return { apiKey: key };
    }
  }
  if (info?.type === "oauth") {
    const access = "access" in info ? info.access : undefined;
    const refresh = "refresh" in info ? info.refresh : undefined;
    if (nonEmpty(access) && nonEmpty(refresh)) {
      return {
        credentials: {
          accessToken: access,
          refreshToken: refresh,
        },
      };
    }
  }
  return {};
}

function successFromTokens(tokens: TokenPair, provider: string): OpenCodeAuthSuccess {
  return {
    type: "success",
    provider,
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: accessExpiryMs(tokens.accessToken),
  };
}

function accessExpiryMs(accessToken: string): number {
  const parts = accessToken.split(".");
  if (parts.length === 3 && parts[1] !== undefined) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { exp?: unknown };
      if (typeof payload.exp === "number") {
        return payload.exp * 1000;
      }
    } catch {
      // Fall through to the default TTL.
    }
  }
  return Date.now() + DEFAULT_TOKEN_TTL_MS;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}
