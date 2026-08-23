import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAuthorized } from "./auth.js";
import { assertListenReady, emptyToUndefined, loadConfig, type ConfigSource, type ServerConfig } from "./config.js";
import {
  HttpError,
  internalError,
  invalidApiKeyError,
  invalidContentTypeError,
  invalidJsonError,
  notFoundError,
  payloadTooLargeError,
  writeJson,
} from "./errors.js";
import { handleChatCompletion, runPinned, type UpstreamPin } from "./openai/completions.js";
import { listModelsResponse, modelNotFoundError, toOpenAIModel } from "./openai/models.js";
import { emptyProvider, type ServerProvider } from "./provider.js";

export type StartedServer = {
  url: string;
  port: number;
  host: string;
  close: () => Promise<void>;
  server: Server;
};

export type StartServerOptions = ConfigSource & {
  config?: ServerConfig;
  provider?: ServerProvider;
};

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const config = options.config ?? loadConfig(options);
  assertListenReady(config);
  const provider = options.provider ?? emptyProvider();
  const pin: UpstreamPin = {};
  const server = createServer((req, res) => {
    void dispatch(req, res, config, provider, pin);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  try {
    await bind(server, config.host, config.port);
  } catch (error) {
    server.close();
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("failed to bind HTTP server");
  }
  const url = bindUrl(config.host, address.port);
  console.log(url);
  return {
    url,
    port: address.port,
    host: config.host,
    server,
    close: () => closeServer(server),
  };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  provider: ServerProvider,
  pin: UpstreamPin,
): Promise<void> {
  const requestId = randomUUID();
  res.setHeader("x-request-id", requestId);
  try {
    if (!isAuthorized(req, config)) {
      writeJson(res, 401, invalidApiKeyError, requestId);
      return;
    }
    await route(req, res, provider, pin, requestId);
  } catch (error) {
    if (error instanceof HttpError) {
      writeJson(res, error.status, error.body, requestId);
      if (error.status === 413) {
        req.destroy();
      }
      return;
    }
    writeJson(res, 500, internalError, requestId);
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  provider: ServerProvider,
  pin: UpstreamPin,
  requestId: string,
): Promise<void> {
  if (pin.error !== undefined) {
    writeJson(res, pin.error.status, pin.error.body, requestId);
    return;
  }
  const path = pathname(req);
  if (req.method === "GET" && path === "/v1/models") {
    const catalogue = await runPinned(pin, () => provider.models());
    writeJson(res, 200, listModelsResponse(catalogue), requestId);
    return;
  }
  if (req.method === "GET" && path.startsWith("/v1/models/")) {
    const id = decodeURIComponent(path.slice("/v1/models/".length));
    const catalogue = await runPinned(pin, () => provider.models());
    const canonical = emptyToUndefined(id) === undefined ? undefined : catalogue.resolve(id);
    if (canonical === undefined) {
      writeJson(res, 404, modelNotFoundError(id), requestId);
      return;
    }
    writeJson(res, 200, toOpenAIModel(canonical), requestId);
    return;
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    const body = await readJson(req);
    await runPinned(pin, () =>
      handleChatCompletion({
        res,
        requestId,
        body,
        provider,
        pin,
      }),
    );
    return;
  }
  writeJson(res, 404, notFoundError, requestId);
}

/** POST JSON bodies only. SSE responses stay unbounded via requestTimeout / headersTimeout = 0. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

function pathname(req: IncomingMessage): string {
  const raw = req.url ?? "/";
  const query = raw.indexOf("?");
  const path = query === -1 ? raw : raw.slice(0, query);
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!isJsonContentType(req.headers["content-type"])) {
    throw new HttpError(400, invalidContentTypeError);
  }
  const declared = declaredContentLength(req.headers["content-length"]);
  if (declared !== undefined && declared > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, payloadTooLargeError);
  }
  const raw = await readBodyLimited(req, MAX_JSON_BODY_BYTES);
  if (raw.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, invalidJsonError);
  }
}

function isJsonContentType(header: string | string[] | undefined): boolean {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) {
    return false;
  }
  const mediaType = raw.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

function declaredContentLength(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    return undefined;
  }
  return n;
}

async function readBodyLimited(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new HttpError(413, payloadTooLargeError);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function bind(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function bindUrl(host: string, port: number): string {
  const hostname = host.includes(":") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}
