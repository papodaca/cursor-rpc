import { Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, type StartedServer } from "../src/server.ts";
import { tempResponsesDbPath } from "./helpers.ts";

const INBOUND_KEY = "sk-inbound-secret";
const CURSOR_TOKEN = "key_planted_cursor";

const servers: StartedServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    await server?.close();
  }
});

async function start(env: Record<string, string | undefined> = {}, argv: string[] = []) {
  const started = await startServer({
    env: {
      CURSOR_API_KEY: CURSOR_TOKEN,
      CURSOR_RPC_OPENAI_API_KEY: INBOUND_KEY,
      CURSOR_RPC_OPENAI_HOST: "127.0.0.1",
      CURSOR_RPC_OPENAI_PORT: "0",
      CURSOR_RPC_OPENAI_RESPONSES_DB: tempResponsesDbPath(),
      ...env,
    },
    argv,
  });
  servers.push(started);
  return started;
}

describe("inbound auth", () => {
  it("reaches a stub 200 when the Bearer matches", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/models`, {
      headers: { Authorization: `Bearer ${INBOUND_KEY}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toMatch(/\S/);
  });

  it("reaches the stub with auth off even when Authorization is missing", async () => {
    const { url } = await start({ CURSOR_RPC_OPENAI_AUTH: "off", CURSOR_RPC_OPENAI_API_KEY: "" });
    const response = await fetch(`${url}/v1/models`);
    expect(response.status).toBe(200);
  });

  it("returns 401 invalid_api_key for a missing or wrong Bearer", async () => {
    const { url } = await start();
    const missing = await fetch(`${url}/v1/models`);
    expect(missing.status).toBe(401);
    const missingBody = (await missing.json()) as { error: Record<string, unknown> };
    expect(missingBody.error.code).toBe("invalid_api_key");
    expect(missingBody.error.type).toBe("invalid_request_error");
    expect(missingBody.error).toHaveProperty("message");
    expect(missingBody.error).toHaveProperty("param");
    expect(JSON.stringify(missingBody)).not.toContain(INBOUND_KEY);
    expect(JSON.stringify(missingBody)).not.toContain(CURSOR_TOKEN);

    const wrong = await fetch(`${url}/v1/models`, {
      headers: { Authorization: "Bearer sk-wrong" },
    });
    expect(wrong.status).toBe(401);
    const wrongBody = await wrong.json();
    expect(wrongBody.error.code).toBe("invalid_api_key");
  });

  it("does not listen when auth is required and the key is unset or empty", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    await expect(
      startServer({
        env: { CURSOR_RPC_OPENAI_HOST: "127.0.0.1", CURSOR_RPC_OPENAI_PORT: "0" },
      }),
    ).rejects.toThrow(/CURSOR_RPC_OPENAI_API_KEY|inbound/i);
    expect(listen).not.toHaveBeenCalled();

    await expect(
      startServer({
        env: {
          CURSOR_RPC_OPENAI_API_KEY: "",
          CURSOR_RPC_OPENAI_HOST: "127.0.0.1",
          CURSOR_RPC_OPENAI_PORT: "0",
        },
      }),
    ).rejects.toThrow(/CURSOR_RPC_OPENAI_API_KEY|inbound/i);
    expect(listen).not.toHaveBeenCalled();
  });

  it("refuses to listen when auth is off and the bind host is 0.0.0.0", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    await expect(
      startServer({
        env: {
          CURSOR_RPC_OPENAI_AUTH: "off",
          CURSOR_RPC_OPENAI_HOST: "0.0.0.0",
          CURSOR_RPC_OPENAI_PORT: "0",
        },
      }),
    ).rejects.toThrow(/loopback|127\.0\.0\.1/i);
    expect(listen).not.toHaveBeenCalled();
  });

  it("still requires a matching Bearer when CURSOR_RPC_OPENAI_AUTH=false", async () => {
    const { url } = await start({ CURSOR_RPC_OPENAI_AUTH: "false" });
    const response = await fetch(`${url}/v1/models`);
    expect(response.status).toBe(401);
  });

  it("does not authenticate from query or JSON api_key", async () => {
    const { url } = await start();
    const query = await fetch(`${url}/v1/models?api_key=${INBOUND_KEY}`);
    expect(query.status).toBe(401);

    const json = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: INBOUND_KEY, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(json.status).toBe(401);
  });

  it("omits the inbound key and planted Cursor token from 401 bodies and process logs", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    const { url } = await start();
    const response = await fetch(`${url}/v1/models`, {
      headers: { Authorization: "Bearer sk-wrong" },
    });
    const body = await response.text();
    const haystack = `${body}\n${lines.join("\n")}`;
    expect(haystack).not.toContain(INBOUND_KEY);
    expect(haystack).not.toContain(CURSOR_TOKEN);
    expect(haystack).not.toContain("sk-wrong");
  });

  it("ignores a dummy Bearer sk-local when auth is off", async () => {
    const { url } = await start({ CURSOR_RPC_OPENAI_AUTH: "off" });
    const response = await fetch(`${url}/v1/models`, {
      headers: { Authorization: "Bearer sk-local" },
    });
    expect(response.status).toBe(200);
  });

  it("returns 401 not 404 for a wrong Bearer on an unknown path", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/not-a-route`, {
      headers: { Authorization: "Bearer sk-wrong" },
    });
    expect(response.status).toBe(401);
    expect(response.status).not.toBe(404);
  });

  it("accepts the api-key header as a Bearer alias", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/models`, {
      headers: { "api-key": INBOUND_KEY },
    });
    expect(response.status).toBe(200);
  });

  it("disables auth with --no-auth on loopback", async () => {
    const { url } = await start({ CURSOR_RPC_OPENAI_API_KEY: undefined }, ["--no-auth"]);
    const response = await fetch(`${url}/v1/models`);
    expect(response.status).toBe(200);
  });
});
