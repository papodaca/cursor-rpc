import { TransportUnsupportedError } from "../errors.js";

export type Http2Decision = {
  usingHttp1: boolean;
  reasonTag: string;
};

export const HTTP2_FORCE_ALL_DISABLED = 1;
export const HTTP2_FORCE_ALL_ENABLED = 2;
export const HTTP2_FORCE_BIDI_DISABLED = 3;
export const HTTP2_FORCE_BIDI_ENABLED = 4;

export function http2Decision(serverHttp2Config: number, localPrefersHttp1 = false): Http2Decision {
  switch (serverHttp2Config) {
    case HTTP2_FORCE_ALL_DISABLED:
      return { usingHttp1: true, reasonTag: "server_force_all_disabled" };
    case HTTP2_FORCE_BIDI_DISABLED:
      return { usingHttp1: true, reasonTag: "server_force_bidi_disabled" };
    case HTTP2_FORCE_ALL_ENABLED:
      return { usingHttp1: false, reasonTag: "server_force_all_enabled" };
    case HTTP2_FORCE_BIDI_ENABLED:
      return { usingHttp1: false, reasonTag: "server_force_bidi_enabled" };
    default:
      return {
        usingHttp1: localPrefersHttp1,
        reasonTag: localPrefersHttp1 ? "local_config_http1" : "default_http2",
      };
  }
}

export function assertRunTransport(decision: Http2Decision): void {
  if (decision.usingHttp1) {
    throw new TransportUnsupportedError(
      `HTTP/2 bidi is unavailable (${decision.reasonTag})`,
      { code: "failed_precondition" },
    );
  }
}

export type AgentUrlConfigLike = {
  agentUrl?: string;
  agentnUrl?: string;
};

export function selectAgentBaseUrl(
  backendUrl: string,
  ghostMode: boolean,
  agentUrlConfig: AgentUrlConfigLike | undefined,
  usingHttp1: boolean,
): string {
  const backend = backendUrl.replace(/\/+$/, "");
  if (/localhost|lclhst\.build|staging\.cursor\.sh|dev-staging\.cursor\.sh/i.test(backend)) {
    return backend;
  }
  if (usingHttp1) {
    return backend;
  }
  const parsed = parseAgentUrlConfig(agentUrlConfig);
  if (parsed !== undefined) {
    return ghostMode ? parsed.agentUrl : parsed.agentnUrl;
  }
  return backend;
}

export function parseAgentUrlConfig(config: AgentUrlConfigLike | undefined): { agentUrl: string; agentnUrl: string } | undefined {
  if (config === undefined) {
    return undefined;
  }
  const agentUrl = config.agentUrl?.trim();
  const agentnUrl = config.agentnUrl?.trim();
  if (agentUrl === undefined || agentUrl === "" || agentnUrl === undefined || agentnUrl === "") {
    return undefined;
  }
  if (!isSafeHttpUrl(agentUrl) || !isSafeHttpUrl(agentnUrl)) {
    return undefined;
  }
  return { agentUrl: agentUrl.replace(/\/+$/, ""), agentnUrl: agentnUrl.replace(/\/+$/, "") };
}

export function privacyProbeUrl(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    if (url.hostname.endsWith("cursor.sh")) {
      return "https://api2.cursor.sh";
    }
  } catch {
    return apiUrl;
  }
  return apiUrl.replace(/\/+$/, "");
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
