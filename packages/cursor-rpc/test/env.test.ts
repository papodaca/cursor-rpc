import { afterEach, describe, expect, it } from "vitest";
import { CursorRpcError } from "../src/errors.ts";
import { resolveEnvironment } from "../src/env.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("resolveEnvironment", () => {
  it("maps https://cursor.com to the prod API https://api2.cursor.sh", () => {
    const resolved = resolveEnvironment({ apiEndpoint: "https://cursor.com" });
    expect(resolved.apiUrl).toBe("https://api2.cursor.sh");
    expect(resolved.websiteUrl).toBe("https://cursor.com");
  });

  it("throws before any request when a URL contains #", () => {
    expect(() => resolveEnvironment({ apiEndpoint: "https://api2.cursor.sh#evil" })).toThrow(CursorRpcError);
    expect(() => resolveEnvironment({ websiteUrl: "https://cursor.com#x" })).toThrow(/#/);
  });

  it("throws before any request when a URL has userinfo or a non-http(s) scheme", () => {
    expect(() => resolveEnvironment({ apiEndpoint: "https://user:pass@api2.cursor.sh" })).toThrow(CursorRpcError);
    expect(() => resolveEnvironment({ apiEndpoint: "file:///tmp/api" })).toThrow(CursorRpcError);
    expect(() => resolveEnvironment({ websiteUrl: "ftp://cursor.com" })).toThrow(CursorRpcError);
  });

  it("prefers constructor options over CURSOR_API_ENDPOINT and CURSOR_API_BASE_URL", () => {
    process.env.CURSOR_API_ENDPOINT = "https://staging.cursor.sh";
    process.env.CURSOR_API_BASE_URL = "https://dev-staging.cursor.sh";
    const resolved = resolveEnvironment({ apiEndpoint: "https://api.playground.cursor.sh" });
    expect(resolved.apiUrl).toBe("https://api.playground.cursor.sh");
    expect(resolved.websiteUrl).toBe("https://playground.cursor.com");
  });
});
