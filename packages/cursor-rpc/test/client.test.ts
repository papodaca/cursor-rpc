import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuthenticationError } from "../src/errors.ts";
import { MemoryCredentialStore } from "../src/credentials.ts";
import { PrivacyMode, GetUserPrivacyModeResponseSchema } from "../src/generated/aiserver/v1/dashboard_pb.ts";
import {
  AvailableModelsResponseSchema,
  GetDefaultModelForCliResponseSchema,
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/generated/aiserver/v1/models_pb.ts";
import { GetServerConfigResponseSchema, Http2Config } from "../src/generated/aiserver/v1/server_config_pb.ts";
import { createClient, login } from "../src/index.ts";
import type { BootstrapClients } from "../src/session/bootstrap.ts";

const MODEL = create(ModelDetailsSchema, { modelId: "composer-2.5", displayName: "Composer" });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bootstrapClients(overrides: Partial<BootstrapClients> = {}): BootstrapClients {
  return {
    getServerConfig: async () =>
      create(GetServerConfigResponseSchema, {
        http2Config: Http2Config.FORCE_ALL_ENABLED,
      }),
    getUserPrivacyMode: async () => create(GetUserPrivacyModeResponseSchema, { privacyMode: PrivacyMode.NO_TRAINING }),
    getUsableModels: async () => create(GetUsableModelsResponseSchema, { models: [MODEL] }),
    getDefaultModelForCli: async () => create(GetDefaultModelForCliResponseSchema, { model: MODEL }),
    availableModels: async () => create(AvailableModelsResponseSchema, { models: [] }),
    ...overrides,
  };
}

describe("createClient", () => {
  it("with an apiKey exposes run and models", async () => {
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      fetch: async () => jsonResponse(200, { accessToken: "tok", refreshToken: "ref" }),
      bootstrapClients: bootstrapClients(),
    });
    expect(typeof client.models).toBe("function");
    expect(typeof client.run).toBe("function");
    const models = await client.models();
    expect(models.models[0]?.modelId).toBe("composer-2.5");
  });

  it("throws before network when credentials and store are empty", async () => {
    let fetches = 0;
    expect(() =>
      createClient({
        env: {},
        store: new MemoryCredentialStore(),
        fetch: async () => {
          fetches += 1;
          throw new Error("network");
        },
      }),
    ).toThrow(AuthenticationError);
    expect(fetches).toBe(0);
  });

  it("does not exchange the API key again after Unauthenticated on the same Client", async () => {
    let exchanges = 0;
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      fetch: async (input) => {
        if (String(input).includes("exchange_user_api_key")) {
          exchanges += 1;
          return jsonResponse(200, { accessToken: "access-token", refreshToken: "refresh-token" });
        }
        throw new Error(`unexpected fetch ${String(input)}`);
      },
      bootstrapClients: bootstrapClients({
        getServerConfig: async () => {
          throw new ConnectError("expired", Code.Unauthenticated);
        },
      }),
    });
    await expect(client.models()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(exchanges).toBe(1);
    await expect(client.models()).rejects.toBeInstanceOf(AuthenticationError);
    expect(exchanges).toBe(1);
  });

  it("README positions the library as a protocol client, not @cursor/sdk", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    const paragraphs = readme.split(/\n\s*\n/).map((block) => block.trim()).filter((block) => block.length > 0);
    const first = paragraphs.find((block) => !block.startsWith("#")) ?? "";
    expect(first.toLowerCase()).toContain("protocol client");
    expect(first).toMatch(/not `@cursor\/sdk`/);
    expect(first.toLowerCase()).toContain("not a local agent runtime");
  });
});

describe("README example", () => {
  it("compiles against public types", () => {
    async function readmeAskExample(apiKey: string): Promise<string> {
      const client = createClient({ apiKey, env: { CURSOR_API_KEY: apiKey } });
      const models = await client.models();
      const run = await client.run({ prompt: "Say hello" });
      for await (const event of run) {
        if (event.type === "text_delta") {
          void event.text;
        }
      }
      const result = await run.wait();
      return `${models.models.length}:${result.text}`;
    }
    expect(typeof readmeAskExample).toBe("function");
    expect(typeof login).toBe("function");
  });
});
