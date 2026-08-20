import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAuthorized } from "./auth.js";
import { assertListenReady, loadConfig, type ConfigSource, type ServerConfig } from "./config.js";
import { invalidApiKeyError, writeJson } from "./errors.js";

export type StartedServer = {
  url: string;
  port: number;
  host: string;
  close: () => Promise<void>;
  server: Server;
};

export type RequestHandler = (req: IncomingMessage, res: ServerResponse, requestId: string) => void | Promise<void>;

export type StartServerOptions = ConfigSource & {
  config?: ServerConfig;
  handler?: RequestHandler;
};

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const config = options.config ?? loadConfig(options);
  assertListenReady(config);
  const server = createServer((req, res) => {
    void dispatch(req, res, config, options.handler);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  await bind(server, config.host, config.port);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to bind HTTP server");
  }
  const url = bindUrl(config.host, address.port);
  console.log(url);
  return {
    url,
    port: address.port,
    host: config.host,
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  handler: RequestHandler | undefined,
): Promise<void> {
  const requestId = randomUUID();
  res.setHeader("x-request-id", requestId);
  try {
    if (!isAuthorized(req, config)) {
      writeJson(res, 401, invalidApiKeyError, requestId);
      return;
    }
    if (handler !== undefined) {
      await handler(req, res, requestId);
      return;
    }
    writeJson(res, 200, { object: "stub" }, requestId);
  } catch {
    writeJson(
      res,
      500,
      {
        error: {
          message: "Internal server error",
          type: "api_error",
          param: null,
          code: "internal_error",
        },
      },
      requestId,
    );
  }
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
