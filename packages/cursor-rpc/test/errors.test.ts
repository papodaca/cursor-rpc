import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CancelledError,
  CursorRpcError,
  PolicyError,
  StreamError,
  TransportUnsupportedError,
} from "../src/index.ts";

describe("public errors", () => {
  it("AuthenticationError is an Error subclass with isRetryable === false", () => {
    const error = new AuthenticationError("invalid token, please log in again");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CursorRpcError);
    expect(error.isRetryable).toBe(false);
    expect(error.name).toBe("AuthenticationError");
  });

  it("toJSON omits token-like fields", () => {
    const error = new AuthenticationError("auth failed", {
      requestId: "req-1",
      code: "unauthenticated",
    });
    Object.assign(error, {
      accessToken: "tok_secret",
      apiKey: "key_secret",
      refreshToken: "ref_secret",
      verifier: "poll_verifier",
      authorization: "Bearer leaked",
    });

    const json = error.toJSON() as Record<string, unknown>;
    expect(json).toMatchObject({
      name: "AuthenticationError",
      code: "unauthenticated",
      isRetryable: false,
      requestId: "req-1",
    });
    expect(json).not.toHaveProperty("accessToken");
    expect(json).not.toHaveProperty("apiKey");
    expect(json).not.toHaveProperty("refreshToken");
    expect(json).not.toHaveProperty("verifier");
    expect(json).not.toHaveProperty("authorization");
    expect(JSON.stringify(json)).not.toMatch(/tok_secret|key_secret|ref_secret|poll_verifier|Bearer leaked/);
  });

  it("constructing CancelledError from an abort maps code to cancelled", () => {
    const abort = new DOMException("This operation was aborted", "AbortError");
    const error = CancelledError.fromAbort(abort);
    expect(error).toBeInstanceOf(CancelledError);
    expect(error.code).toBe("cancelled");
    expect(error.isRetryable).toBe(false);
  });

  it("wrapping a cause whose message contains Bearer omits that substring from public message and toJSON", () => {
    const cause = new Error("upstream failed: Bearer super-secret-token");
    const error = CursorRpcError.from(cause, {
      code: "unavailable",
      isRetryable: true,
    });
    expect(error.message).not.toContain("Bearer");
    expect(error.message).not.toContain("super-secret-token");
    expect(JSON.stringify(error.toJSON())).not.toContain("Bearer");
    expect(JSON.stringify(error.toJSON())).not.toContain("super-secret-token");
    expect(inspect(error)).not.toContain("Bearer");
    expect(inspect(error)).not.toContain("super-secret-token");
  });

  it("PolicyError, StreamError, and TransportUnsupportedError are CursorRpcError subclasses", () => {
    expect(new PolicyError("sign_in_policy_violation")).toBeInstanceOf(CursorRpcError);
    expect(new StreamError("stall", { code: "deadline_exceeded", isRetryable: true }).isRetryable).toBe(
      true,
    );
    expect(new TransportUnsupportedError("http1_forced", { code: "failed_precondition" })).toBeInstanceOf(
      CursorRpcError,
    );
  });
});
