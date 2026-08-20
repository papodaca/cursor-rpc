import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ServerConfig } from "./config.js";

export function isAuthorized(req: IncomingMessage, config: ServerConfig): boolean {
  if (!config.authRequired) {
    return true;
  }
  const presented = presentedToken(req);
  if (presented === undefined || config.apiKey === undefined) {
    return false;
  }
  return safeEqual(presented, config.apiKey);
}

export function presentedToken(req: IncomingMessage): string | undefined {
  const authorization = headerValue(req, "authorization");
  if (authorization !== undefined) {
    const match = /^Bearer\s+(\S+)/i.exec(authorization);
    const bearer = match?.[1];
    if (bearer !== undefined) {
      return bearer;
    }
  }
  return emptyToUndefined(headerValue(req, "api-key"));
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return emptyToUndefined(value[0]);
  }
  return emptyToUndefined(value);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  return value;
}
