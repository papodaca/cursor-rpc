import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AuthenticationError, CancelledError, PolicyError } from "../errors.js";
import { parseAuthJsonResponse, type FetchLike, type TokenPair } from "./api-key.js";

const MAX_ATTEMPTS = 150;
const CONSECUTIVE_FAILURE_BUDGET = 3;

export type LoginChallenge = {
  uuid: string;
  verifier: string;
  challenge: string;
  url: string;
};

export type CreateLoginChallengeOptions = {
  websiteUrl: string;
  redirectTarget?: string;
  randomBytes?: (size: number) => Uint8Array;
  uuid?: () => string;
};

export function createLoginChallenge(options: CreateLoginChallengeOptions): LoginChallenge {
  const bytes = options.randomBytes?.(32) ?? randomBytes(32);
  const verifier = toBase64Url(bytes);
  const challenge = toBase64Url(createHash("sha256").update(verifier, "utf8").digest());
  const uuid = options.uuid?.() ?? randomUUID();
  const websiteUrl = stripTrailingSlash(options.websiteUrl);
  const redirectTarget = options.redirectTarget ?? "cli";
  const url =
    `${websiteUrl}/loginDeepControl?challenge=${encodeURIComponent(challenge)}` +
    `&uuid=${encodeURIComponent(uuid)}&mode=login&redirectTarget=${encodeURIComponent(redirectTarget)}`;
  return { uuid, verifier, challenge, url };
}

export async function pollLogin(
  apiUrl: string,
  challenge: Pick<LoginChallenge, "uuid" | "verifier">,
  options: {
    fetch?: FetchLike;
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<TokenPair> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) {
      throw CancelledError.fromAbort(options.signal.reason);
    }
    const pollUrl =
      `${stripTrailingSlash(apiUrl)}/auth/poll?uuid=${encodeURIComponent(challenge.uuid)}` +
      `&verifier=${encodeURIComponent(challenge.verifier)}`;
    let response: Response;
    try {
      response = await fetchImpl(pollUrl, {
        method: "GET",
        headers: { "content-type": "application/json" },
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw CancelledError.fromAbort(options.signal.reason);
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_BUDGET) {
        throw AuthenticationError.from(error, { code: "unauthenticated" });
      }
      await sleep(backoffMs(attempt), options.signal);
      continue;
    }
    if (response.status === 404) {
      consecutiveFailures = 0;
      await sleep(backoffMs(attempt), options.signal);
      continue;
    }
    if (response.status === 403) {
      const json = await response.clone().json().catch(() => undefined) as { error?: unknown } | undefined;
      if (json?.error === "sign_in_policy_violation") {
        throw new PolicyError("sign_in_policy_violation");
      }
    }
    if (response.ok) {
      return await parseAuthJsonResponse(response, "login poll failed");
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_BUDGET) {
      throw new AuthenticationError("invalid token, please log in again", { code: "unauthenticated" });
    }
    await sleep(backoffMs(attempt), options.signal);
  }
  throw new AuthenticationError("invalid token, please log in again", { code: "unauthenticated" });
}

export function backoffMs(attempt: number): number {
  return Math.min(1000 * 1.2 ** attempt, 10_000);
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw CancelledError.fromAbort(signal.reason);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(CancelledError.fromAbort(signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
