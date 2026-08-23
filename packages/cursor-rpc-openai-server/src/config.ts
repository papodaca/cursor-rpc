import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type ServerConfig = {
  host: string;
  port: number;
  authRequired: boolean;
  apiKey: string | undefined;
};

export type ConfigSource = {
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export function loadConfig(source: ConfigSource = {}): ServerConfig {
  const env = source.env ?? process.env;
  const flags = parseArgv(source.argv ?? []);
  return {
    host: flags.host ?? emptyToUndefined(env.CURSOR_RPC_OPENAI_HOST) ?? "127.0.0.1",
    port: parsePort(flags.port ?? env.CURSOR_RPC_OPENAI_PORT ?? "8787"),
    authRequired: flags.noAuth ? false : env.CURSOR_RPC_OPENAI_AUTH !== "off",
    apiKey: emptyToUndefined(env.CURSOR_RPC_OPENAI_API_KEY),
  };
}

export function assertListenReady(config: ServerConfig): void {
  if (config.authRequired && config.apiKey === undefined) {
    throw new Error("CURSOR_RPC_OPENAI_API_KEY is required unless inbound auth is disabled");
  }
  if (!config.authRequired && !isLoopbackHost(config.host)) {
    throw new Error("inbound auth off requires a loopback bind (127.0.0.1 or ::1)");
  }
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

function parseArgv(argv: readonly string[]): { host?: string; port?: string; noAuth: boolean } {
  let host: string | undefined;
  let port: string | undefined;
  let noAuth = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-auth") {
      noAuth = true;
      continue;
    }
    if (arg === "--host" || arg === "--port") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--host") {
        host = value;
      } else {
        port = value;
      }
      i += 1;
      continue;
    }
    if (arg?.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }
    if (arg?.startsWith("--port=")) {
      port = arg.slice("--port=".length);
    }
  }
  return { host, port, noAuth };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

export function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}

export type ResponsesDbPathSource = {
  env?: Record<string, string | undefined>;
  cwd?: string;
};

export function resolveResponsesDbPath(source: ResponsesDbPathSource = {}): string {
  const env = source.env ?? process.env;
  const cwd = source.cwd ?? process.cwd();
  const configured = env.CURSOR_RPC_OPENAI_RESPONSES_DB;
  if (configured === undefined) {
    return defaultResponsesDbPath(env, cwd);
  }
  return normalizeResponsesDbPath(configured, cwd);
}

export function normalizeResponsesDbPath(value: string | undefined, cwd = process.cwd()): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("CURSOR_RPC_OPENAI_RESPONSES_DB must not be empty");
  }
  const trimmed = value.trim();
  if (trimmed === ":memory:") {
    return trimmed;
  }
  if (/^file:/i.test(trimmed) || trimmed.includes("?")) {
    throw new Error("CURSOR_RPC_OPENAI_RESPONSES_DB must be a filesystem path, not a SQLite URI");
  }
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

function defaultResponsesDbPath(env: Record<string, string | undefined>, cwd: string): string {
  const xdg = emptyToUndefined(env.XDG_DATA_HOME);
  if (xdg !== undefined) {
    return resolve(cwd, xdg, "cursor-rpc-openai-server", "responses.sqlite");
  }
  const home = emptyToUndefined(env.HOME) ?? homedir();
  return resolve(home, ".local", "share", "cursor-rpc-openai-server", "responses.sqlite");
}
