import type { DescMessage, DescMethodUnary, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { MemoryCredentialStore, type CredentialStore } from "../credentials.js";
import type { FetchLike, TokenPair } from "../auth/api-key.js";
import { AuthSession } from "../auth/session.js";
import { resolveEnvironment } from "../env.js";
import { AuthenticationError, CancelledError, CursorRpcError } from "../errors.js";
import { AiService } from "../generated/aiserver/v1/ai_pb.js";
import {
  createOriginConnection,
  mapTransportError,
  unaryCall,
  type OriginConnection,
} from "../transport/connect.js";

export type CreateWebClientOptions = {
  apiKey?: string;
  authToken?: string;
  credentials?: TokenPair;
  apiEndpoint?: string;
  apiBaseUrl?: string;
  websiteUrl?: string;
  store?: CredentialStore;
  headers?: Headers;
  signal?: AbortSignal;
  clientType?: string;
  clientVersion?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  insecure?: boolean;
};

export type WebClientFetchOutcome =
  | { ok: true; content: string }
  | { ok: false; error: string; isTimeout: boolean };

export type WebClientSearchDocument = {
  url: string;
  title: string;
  text: string;
};

export type WebClientSearchOutcome =
  | { ok: true; documents: WebClientSearchDocument[]; answer?: string }
  | { ok: false; error: string };

export type WebClient = {
  fetch: (url: string, options?: { signal?: AbortSignal }) => Promise<WebClientFetchOutcome>;
  search: (term: string, options?: { signal?: AbortSignal }) => Promise<WebClientSearchOutcome>;
  close: () => void;
};

export function createWebClient(options: CreateWebClientOptions = {}): WebClient {
  return new WebClientImpl(options);
}

/** Test-only transport seam. Not re-exported from the package index. */
export function createWebClientWithTransport(
  transport: Transport,
  options: CreateWebClientOptions = {},
): WebClient {
  return new WebClientImpl(options, transport);
}

class WebClientImpl implements WebClient {
  #options: CreateWebClientOptions;
  #auth: AuthSession;
  #connection: OriginConnection | undefined;
  #transport: Transport;
  #bearer: string | undefined;
  #tokenFlight: Promise<string> | undefined;
  #modelFlight: Promise<string> | undefined;
  #closed = false;

  constructor(options: CreateWebClientOptions, transport?: Transport) {
    this.#options = options;
    const env = options.env ?? process.env;
    const environment = resolveEnvironment({
      apiEndpoint: options.apiEndpoint,
      apiBaseUrl: options.apiBaseUrl,
      websiteUrl: options.websiteUrl,
      env,
    });
    this.#auth = new AuthSession({
      apiUrl: environment.apiUrl,
      store: options.store ?? new MemoryCredentialStore(),
      authToken: options.authToken,
      apiKey: options.apiKey,
      credentials: options.credentials,
      env,
      fetch: options.fetch,
      signal: options.signal,
    });
    if (transport !== undefined) {
      this.#transport = transport;
      return;
    }
    const connection = createOriginConnection(new URL(environment.apiUrl).origin, {
      getAccessToken: () => this.#bearer,
      extraHeaders: options.headers,
      clientType: options.clientType,
      clientVersion: options.clientVersion,
      insecure: options.insecure,
    });
    this.#connection = connection;
    this.#transport = connection.transport;
  }

  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<WebClientFetchOutcome> {
    const response = await this.#unary(AiService.method.runWebFetch, { url }, options.signal);
    if (response.result.case === "success") {
      return { ok: true, content: response.result.value.content };
    }
    if (response.result.case === "error") {
      return {
        ok: false,
        error: new CursorRpcError(response.result.value.error).message,
        isTimeout: response.result.value.isTimeout,
      };
    }
    throw new CursorRpcError("RunWebFetch returned no result", { code: "internal" });
  }

  async search(term: string, options: { signal?: AbortSignal } = {}): Promise<WebClientSearchOutcome> {
    const modelId = await this.#modelId(options.signal);
    const response = await this.#unary(
      AiService.method.runWebSearch,
      { searchTerm: term, modelId },
      options.signal,
    );
    return {
      ok: true,
      documents: response.documents.map((document) => ({
        url: document.url,
        title: document.title,
        text: document.text,
      })),
      ...(response.answer === undefined ? {} : { answer: response.answer }),
    };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#connection?.close();
  }

  async #modelId(signal?: AbortSignal): Promise<string> {
    this.#throwIfClosed(signal);
    await this.#refreshBearer();
    this.#throwIfClosed(signal);
    this.#modelFlight ??= this.#resolveModelId();
    try {
      const modelId = await this.#modelFlight;
      this.#throwIfClosed(signal);
      return modelId;
    } catch (error) {
      if (signal?.aborted) {
        throw CancelledError.fromAbort(signal.reason);
      }
      throw error;
    }
  }

  async #resolveModelId(): Promise<string> {
    const catalogueSignal = this.#options.signal;
    try {
      const def = await unaryCall(this.#transport, AiService.method.getDefaultModelForCli, {}, {
        signal: catalogueSignal,
      });
      const defaultId = def.model?.modelId?.trim();
      if (defaultId) {
        return defaultId;
      }
    } catch (error) {
      const mapped = error instanceof CursorRpcError ? error : mapTransportError(error);
      this.#recordAuthFailure(mapped);
      throw mapped;
    }
    try {
      const usable = await unaryCall(this.#transport, AiService.method.getUsableModels, {}, {
        signal: catalogueSignal,
      });
      const first = usable.models.find((model) => model.modelId.trim() !== "")?.modelId;
      if (first !== undefined) {
        return first;
      }
    } catch (error) {
      const mapped = error instanceof CursorRpcError ? error : mapTransportError(error);
      this.#recordAuthFailure(mapped);
      throw mapped;
    }
    throw new CursorRpcError("No model found.", { code: "failed_precondition" });
  }

  async #unary<I extends DescMessage, O extends DescMessage>(
    method: DescMethodUnary<I, O>,
    input: MessageInitShape<I>,
    callSignal?: AbortSignal,
  ): Promise<MessageShape<O>> {
    this.#throwIfClosed(callSignal);
    const signal = combineSignals(callSignal, this.#options.signal);
    this.#throwIfClosed(signal);
    try {
      await this.#refreshBearer();
      this.#throwIfClosed(signal);
      return await unaryCall(this.#transport, method, input, { signal });
    } catch (error) {
      const mapped = error instanceof CursorRpcError ? error : mapTransportError(error);
      this.#recordAuthFailure(mapped);
      throw mapped;
    }
  }

  async #refreshBearer(): Promise<void> {
    if (this.#auth.pinned) {
      throw new AuthenticationError("invalid token, please log in again");
    }
    this.#tokenFlight ??= this.#auth
      .accessToken()
      .then((token) => {
        this.#bearer = token;
        return token;
      })
      .finally(() => {
        this.#tokenFlight = undefined;
      });
    await this.#tokenFlight;
  }

  #recordAuthFailure(error: unknown): void {
    if (this.#auth.handleAuthFailure(error, this.#bearer !== undefined)) {
      this.#bearer = undefined;
    }
  }

  #throwIfClosed(signal?: AbortSignal): void {
    if (this.#closed) {
      throw new CursorRpcError("web client is closed", { code: "failed_precondition" });
    }
    if (signal?.aborted) {
      throw CancelledError.fromAbort(signal.reason);
    }
  }
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((value): value is AbortSignal => value !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  if (present.length === 1) {
    return present[0];
  }
  return AbortSignal.any(present);
}
