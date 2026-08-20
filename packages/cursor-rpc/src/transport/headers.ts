import { randomUUID } from "node:crypto";
import type { Interceptor } from "@connectrpc/connect";

export const DEFAULT_CLIENT_TYPE = "private_worker";
export const DEFAULT_CLIENT_VERSION = "1.0.0";

export type HeaderProviders = {
  getAccessToken?: () => string | undefined;
  getGhostMode?: () => boolean;
  getApiKey?: () => string | undefined;
  clientType?: string;
  clientVersion?: string;
  extraHeaders?: Headers;
};

export function createHeaderInterceptor(providers: HeaderProviders = {}): Interceptor {
  return (next) => async (req) => {
    applyProtocolHeaders(req.header, providers, req.method.name);
    return await next(req);
  };
}

export function applyProtocolHeaders(
  headers: Headers,
  providers: HeaderProviders,
  methodName: string,
): void {
  const extra = new Headers(providers.extraHeaders);
  extra.delete("x-cursor-checksum");
  extra.forEach((value, key) => {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  });

  if (!headers.has("x-request-id")) {
    headers.set("x-request-id", randomUUID());
  }
  if (methodName === "Run" && !headers.has("x-original-request-id")) {
    headers.set("x-original-request-id", headers.get("x-request-id") ?? randomUUID());
  }

  if (!headers.has("x-cursor-client-type")) {
    headers.set("x-cursor-client-type", providers.clientType ?? DEFAULT_CLIENT_TYPE);
  }
  if (!headers.has("x-cursor-client-version")) {
    headers.set("x-cursor-client-version", providers.clientVersion ?? DEFAULT_CLIENT_VERSION);
  }
  headers.set("x-ghost-mode", ghostModeHeader(providers.getGhostMode));

  const token = safeToken(providers.getAccessToken);
  if (token !== undefined) {
    headers.set("authorization", `Bearer ${token}`);
  } else {
    headers.delete("authorization");
  }

  const apiKey = providers.getApiKey?.();
  if (apiKey !== undefined && headers.get("authorization") === `Bearer ${apiKey}`) {
    headers.delete("authorization");
  }
}

function ghostModeHeader(getGhostMode: HeaderProviders["getGhostMode"]): "true" | "false" {
  try {
    const value = getGhostMode?.();
    if (value === false) {
      return "false";
    }
    if (value === true) {
      return "true";
    }
    return "true";
  } catch {
    return "true";
  }
}

function safeToken(getAccessToken: HeaderProviders["getAccessToken"]): string | undefined {
  try {
    const token = getAccessToken?.();
    if (typeof token !== "string" || token.trim() === "") {
      return undefined;
    }
    return token;
  } catch {
    return undefined;
  }
}
