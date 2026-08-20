import { AuthenticationError, CursorRpcError } from "./errors.js";
import { MemoryCredentialStore, type CredentialStore } from "./credentials.js";
import { AuthSession } from "./auth/session.js";
import { createLoginChallenge, pollLogin, type LoginChallenge } from "./auth/login.js";
import type { FetchLike, TokenPair } from "./auth/api-key.js";
import { resolveEnvironment, type ResolvedEnvironment } from "./env.js";
import { AiService } from "./generated/aiserver/v1/ai_pb.js";
import { DashboardService } from "./generated/aiserver/v1/dashboard_pb.js";
import { ServerConfigService } from "./generated/aiserver/v1/server_config_pb.js";
import { AgentService, type AgentClientMessage, type AgentServerMessage, type ConversationHistory } from "./generated/agent/v1/agent_pb.js";
import {
  createOriginConnection,
  createServiceClient,
  mapTransportError,
  unaryCall,
  type OriginConnection,
} from "./transport/connect.js";
import { bootstrap, type BootstrapClients, type BootstrapSession } from "./session/bootstrap.js";
import { assertRunTransport } from "./session/host.js";
import type { ModelCatalogue } from "./session/models.js";
import type { DispatchHandlers } from "./run/dispatch.js";
import type { RunHandle } from "./run/run.js";
import { runHeaders, runTurn } from "./run/run.js";
import { AsyncQueue } from "./run/queue.js";

export type ClientTools = {
  allowWebSearch?: boolean;
  allowWebFetch?: boolean;
  allowed?: string[];
  exclude?: string[];
};

export type CreateClientOptions = {
  apiKey?: string;
  authToken?: string;
  apiEndpoint?: string;
  apiBaseUrl?: string;
  websiteUrl?: string;
  store?: CredentialStore;
  headers?: Headers;
  tools?: ClientTools;
  signal?: AbortSignal;
  clientType?: string;
  clientVersion?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  insecure?: boolean;
  bootstrapClients?: BootstrapClients;
  openRun?: (
    outbound: AsyncIterable<AgentClientMessage>,
    options: { signal?: AbortSignal; headers?: Headers },
  ) => AsyncIterable<AgentServerMessage>;
};

export type ClientRunOptions = {
  prompt: string;
  conversationHistory?: ConversationHistory;
  signal?: AbortSignal;
  handlers?: DispatchHandlers;
  allowWebSearch?: boolean;
  allowWebFetch?: boolean;
};

export type CursorRpcClient = {
  models: (signal?: AbortSignal) => Promise<ModelCatalogue>;
  run: (options: ClientRunOptions) => Promise<RunHandle>;
};

export function createClient(options: CreateClientOptions = {}): CursorRpcClient {
  const env = options.env ?? process.env;
  const store = options.store ?? new MemoryCredentialStore();
  if (!hasCredentials(options, store, env)) {
    throw new AuthenticationError("authentication required");
  }
  const environment = resolveEnvironment({
    apiEndpoint: options.apiEndpoint,
    apiBaseUrl: options.apiBaseUrl,
    websiteUrl: options.websiteUrl,
    env,
  });
  const auth = new AuthSession({
    apiUrl: environment.apiUrl,
    store,
    authToken: options.authToken,
    apiKey: options.apiKey,
    env,
    fetch: options.fetch,
    signal: options.signal,
  });
  return new CursorRpcClientImpl(options, environment, auth);
}

export function login(
  options: {
    apiEndpoint?: string;
    apiBaseUrl?: string;
    websiteUrl?: string;
    store?: CredentialStore;
    signal?: AbortSignal;
    fetch?: FetchLike;
    env?: Record<string, string | undefined>;
  } = {},
): { url: string; challenge: LoginChallenge; wait: (signal?: AbortSignal) => Promise<TokenPair> } {
  const environment = resolveEnvironment(options);
  const challenge = createLoginChallenge({ websiteUrl: environment.websiteUrl });
  return {
    url: challenge.url,
    challenge,
    wait: async (signal) => {
      const tokens = await pollLogin(environment.apiUrl, challenge, {
        fetch: options.fetch,
        signal: signal ?? options.signal,
      });
      await options.store?.save(tokens);
      return tokens;
    },
  };
}

class CursorRpcClientImpl implements CursorRpcClient {
  #options: CreateClientOptions;
  #environment: ResolvedEnvironment;
  #auth: AuthSession;
  #bearer: string | undefined;
  #session: BootstrapSession | undefined;
  #origins = new Map<string, OriginConnection>();

  constructor(options: CreateClientOptions, environment: ResolvedEnvironment, auth: AuthSession) {
    this.#options = options;
    this.#environment = environment;
    this.#auth = auth;
  }

  async models(signal?: AbortSignal): Promise<ModelCatalogue> {
    try {
      const session = await this.#ensureSession(signal);
      return session.models;
    } catch (error) {
      this.#recordAuthFailure(error);
      throw error instanceof CursorRpcError ? error : mapTransportError(error);
    }
  }

  async run(options: ClientRunOptions): Promise<RunHandle> {
    try {
      const session = await this.#ensureSession(options.signal);
      assertRunTransport(session.http2);
      await this.#refreshBearer(options.signal);
      const outbound = new AsyncQueue<AgentClientMessage>();
      const headers = agentToolHeaders(this.#options.tools, options);
      const signal = options.signal ?? this.#options.signal;
      const inbound = this.#options.openRun
        ? this.#options.openRun(outbound, { signal, headers })
        : this.#agentRun(session, outbound, signal, headers);
      const handle = runTurn({
        prompt: options.prompt,
        conversationHistory: options.conversationHistory,
        inbound,
        send: (message) => {
          outbound.push(message);
        },
        signal,
        handlers: options.handlers,
        allowWebSearch: options.allowWebSearch ?? this.#options.tools?.allowWebSearch,
        allowWebFetch: options.allowWebFetch ?? this.#options.tools?.allowWebFetch,
        auth: this.#auth,
        onUnauthenticated: (error) => {
          this.#recordAuthFailure(error);
        },
      });
      return attachOutbound(handle, outbound);
    } catch (error) {
      this.#recordAuthFailure(error);
      throw error instanceof CursorRpcError ? error : mapTransportError(error);
    }
  }

  async #ensureSession(signal?: AbortSignal): Promise<BootstrapSession> {
    await this.#refreshBearer(signal);
    if (this.#session !== undefined) {
      return this.#session;
    }
    this.#session = await bootstrap({
      apiUrl: this.#environment.apiUrl,
      getAccessToken: async () => {
        await this.#refreshBearer(signal);
        if (this.#bearer === undefined) {
          throw new AuthenticationError("authentication required");
        }
        return this.#bearer;
      },
      clients: this.#options.bootstrapClients ?? this.#createBootstrapClients(),
    });
    return this.#session;
  }

  async #refreshBearer(signal?: AbortSignal): Promise<void> {
    this.#bearer = await this.#auth.accessToken(signal ?? this.#options.signal);
  }

  #createBootstrapClients(): BootstrapClients {
    return {
      getServerConfig: () =>
        unaryCall(this.#origin(this.#environment.apiUrl).transport, ServerConfigService.method.getServerConfig, {}),
      getUserPrivacyMode: (baseUrl) =>
        unaryCall(this.#origin(baseUrl).transport, DashboardService.method.getUserPrivacyMode, {}),
      getUsableModels: () =>
        unaryCall(this.#origin(this.#environment.apiUrl).transport, AiService.method.getUsableModels, {}),
      getDefaultModelForCli: () =>
        unaryCall(this.#origin(this.#environment.apiUrl).transport, AiService.method.getDefaultModelForCli, {}),
      availableModels: () =>
        unaryCall(this.#origin(this.#environment.apiUrl).transport, AiService.method.availableModels, {
          useModelParameters: true,
        }),
    };
  }

  #agentRun(
    session: BootstrapSession,
    outbound: AsyncIterable<AgentClientMessage>,
    signal: AbortSignal | undefined,
    headers: Headers,
  ): AsyncIterable<AgentServerMessage> {
    const client = createServiceClient(AgentService, this.#origin(session.agentBaseUrl).transport);
    return client.run(outbound, { signal, headers });
  }

  #origin(url: string): OriginConnection {
    const origin = new URL(url).origin;
    const existing = this.#origins.get(origin);
    if (existing !== undefined) {
      return existing;
    }
    const connection = createOriginConnection(origin, {
      getAccessToken: () => this.#bearer,
      getGhostMode: () => this.#session?.ghostMode ?? true,
      extraHeaders: this.#options.headers,
      clientType: this.#options.clientType,
      clientVersion: this.#options.clientVersion,
      insecure: this.#options.insecure,
    });
    this.#origins.set(origin, connection);
    return connection;
  }

  #recordAuthFailure(error: unknown): void {
    if (this.#auth.handleAuthFailure(error, this.#bearer !== undefined)) {
      this.#bearer = undefined;
    }
  }
}

function hasCredentials(
  options: CreateClientOptions,
  store: CredentialStore,
  env: Record<string, string | undefined>,
): boolean {
  if (nonEmpty(options.authToken) || nonEmpty(options.apiKey)) {
    return true;
  }
  if (nonEmpty(env.CURSOR_AUTH_TOKEN) || nonEmpty(env.CURSOR_API_KEY)) {
    return true;
  }
  const loaded = store.load();
  if (loaded instanceof Promise) {
    return true;
  }
  return loaded?.accessToken !== undefined || loaded?.apiKey !== undefined;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function agentToolHeaders(tools: ClientTools | undefined, run: ClientRunOptions): Headers {
  const headers = runHeaders({
    allowWebSearch: run.allowWebSearch ?? tools?.allowWebSearch,
    allowWebFetch: run.allowWebFetch ?? tools?.allowWebFetch,
  });
  if (tools?.exclude !== undefined && tools.exclude.length > 0) {
    const current = headers.get("x-cursor-agent-exclude-tools")?.split(",").filter((name) => name.length > 0) ?? [];
    headers.set("x-cursor-agent-exclude-tools", [...current, ...tools.exclude].join(","));
  }
  if (tools?.allowed !== undefined && tools.allowed.length > 0) {
    headers.set("x-cursor-agent-allowed-tools", tools.allowed.join(","));
  }
  return headers;
}

function attachOutbound(handle: RunHandle, outbound: AsyncQueue<AgentClientMessage>): RunHandle {
  const abort = () => {
    handle.abort();
    outbound.close();
  };
  return {
    wait: async () => {
      try {
        return await handle.wait();
      } finally {
        outbound.close();
      }
    },
    abort,
    conversationHistory: () => handle.conversationHistory(),
    async *[Symbol.asyncIterator]() {
      try {
        yield* handle;
      } finally {
        outbound.close();
      }
    },
  };
}
