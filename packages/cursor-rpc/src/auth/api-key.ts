import { AuthenticationError, PolicyError } from "../errors.js";

export type FetchLike = typeof fetch;

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

export async function exchangeApiKey(
  apiUrl: string,
  apiKey: string,
  options: { fetch?: FetchLike; signal?: AbortSignal } = {},
): Promise<TokenPair> {
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${stripTrailingSlash(apiUrl)}/auth/exchange_user_api_key`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: "{}",
      signal: options.signal,
    });
  } catch (error) {
    throw AuthenticationError.from(error, { code: "unavailable", isRetryable: true });
  }
  return await parseAuthJsonResponse(response, "API key exchange failed");
}

export async function parseAuthJsonResponse(response: Response, fallbackMessage: string): Promise<TokenPair> {
  const bodyText = await response.text();
  const json = parseLooseJson(bodyText);
  if (response.status === 403 && json?.error === "sign_in_policy_violation") {
    throw new PolicyError("sign_in_policy_violation");
  }
  if (response.ok) {
    const accessToken = typeof json?.accessToken === "string" ? json.accessToken : undefined;
    const refreshToken = typeof json?.refreshToken === "string" ? json.refreshToken : undefined;
    if (accessToken !== undefined && refreshToken !== undefined) {
      return { accessToken, refreshToken };
    }
  }
  if (response.status >= 500) {
    throw new AuthenticationError(fallbackMessage, { code: "unavailable", isRetryable: true });
  }
  throw new AuthenticationError("invalid token, please log in again", { code: "unauthenticated" });
}

function parseLooseJson(bodyText: string): { accessToken?: unknown; refreshToken?: unknown; error?: unknown } | undefined {
  try {
    return JSON.parse(bodyText) as { accessToken?: unknown; refreshToken?: unknown; error?: unknown };
  } catch {
    return undefined;
  }
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
