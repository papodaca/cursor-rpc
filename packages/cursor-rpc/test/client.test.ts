import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuthenticationError, TransportUnsupportedError } from "../src/errors.ts";
import { MemoryCredentialStore } from "../src/credentials.ts";
import { PrivacyMode, GetUserPrivacyModeResponseSchema } from "../src/generated/aiserver/v1/dashboard_pb.ts";
import {
  AvailableModelsResponseSchema,
  GetDefaultModelForCliResponseSchema,
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/generated/aiserver/v1/models_pb.ts";
import { GetServerConfigResponseSchema, Http2Config } from "../src/generated/aiserver/v1/server_config_pb.ts";
import {
  AgentServerMessageSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/generated/agent/v1/agent_pb.ts";
import {
  createClient,
  login,
  name,
  type AgentClientMessage,
  type DispatchHandlers,
  type InteractionQuery,
} from "../src/index.ts";
import type { BootstrapClients } from "../src/session/bootstrap.ts";
import type { AgentServerMessage } from "../src/generated/agent/v1/agent_pb.ts";

const MODEL = create(ModelDetailsSchema, { modelId: "composer-2.5", displayName: "Composer" });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textDelta(text: string): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "textDelta",
          value: create(TextDeltaUpdateSchema, { text }),
        },
      }),
    },
  });
}

function turnEnded(): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "turnEnded",
          value: create(TurnEndedUpdateSchema, { inputTokens: 1, outputTokens: 2 }),
        },
      }),
    },
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

  it("accepts a login TokenPair as credentials without exchanging an API key", async () => {
    let fetches = 0;
    const client = createClient({
      credentials: { accessToken: "access-from-login", refreshToken: "refresh-from-login" },
      env: {},
      fetch: async () => {
        fetches += 1;
        throw new Error("network");
      },
      bootstrapClients: bootstrapClients(),
    });
    const models = await client.models();
    expect(models.models[0]?.modelId).toBe("composer-2.5");
    expect(fetches).toBe(0);
    client.close();
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

  it("run sends selected modelId on the opening run_request", async () => {
    let opening: AgentClientMessage | undefined;
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      fetch: async () => jsonResponse(200, { accessToken: "tok", refreshToken: "ref" }),
      bootstrapClients: bootstrapClients(),
      openRun: async function* (outbound) {
        const first = await outbound[Symbol.asyncIterator]().next();
        opening = first.value;
        yield textDelta("hello");
        yield turnEnded();
      },
    });
    await (await client.run({ prompt: "Say hello", modelId: "composer-2.5" })).wait();
    expect(opening?.message.case).toBe("runRequest");
    if (opening?.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    expect(opening.message.value.requestedModel?.modelId).toBe("composer-2.5");
    const action = opening.message.value.action?.action;
    if (action?.case !== "userMessageAction") {
      throw new Error("expected userMessageAction");
    }
    expect(action.value.userMessage?.mode).toBe(2);
    expect(action.value.requestContext?.env?.workspacePaths).toEqual([]);
    expect(opening.message.value.excludeWorkspaceContext).toBe(true);
    client.close();
  });

  it("run sends model_details when a catalogue row is provided", async () => {
    let opening: AgentClientMessage | undefined;
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      fetch: async () => jsonResponse(200, { accessToken: "tok", refreshToken: "ref" }),
      bootstrapClients: bootstrapClients(),
      openRun: async function* (outbound) {
        const first = await outbound[Symbol.asyncIterator]().next();
        opening = first.value;
        yield textDelta("hello");
        yield turnEnded();
      },
    });
    await (await client.run({ prompt: "Say hello", modelDetails: MODEL })).wait();
    expect(opening?.message.case).toBe("runRequest");
    if (opening?.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    expect(opening.message.value.modelDetails?.modelId).toBe("composer-2.5");
    client.close();
  });

  it("run omits model fields when modelId is omitted", async () => {
    let opening: AgentClientMessage | undefined;
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      fetch: async () => jsonResponse(200, { accessToken: "tok", refreshToken: "ref" }),
      bootstrapClients: bootstrapClients(),
      openRun: async function* (outbound) {
        const first = await outbound[Symbol.asyncIterator]().next();
        opening = first.value;
        yield textDelta("hello");
        yield turnEnded();
      },
    });
    await (await client.run({ prompt: "Say hello" })).wait();
    expect(opening?.message.case).toBe("runRequest");
    if (opening?.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    expect(opening.message.value.requestedModel).toBeUndefined();
    expect(opening.message.value.modelDetails).toBeUndefined();
    expect(opening.message.value.customSystemPrompt).toBeUndefined();
    const action = opening.message.value.action?.action;
    if (action?.case !== "userMessageAction") {
      throw new Error("expected userMessageAction");
    }
    expect(action.value.userMessage?.mode).toBe(2);
    client.close();
  });

  it("run resolves a catalogue alias onto requested_model.model_id", async () => {
    let opening: AgentClientMessage | undefined;
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      fetch: async () => jsonResponse(200, { accessToken: "tok", refreshToken: "ref" }),
      bootstrapClients: bootstrapClients(),
      openRun: async function* (outbound) {
        const first = await outbound[Symbol.asyncIterator]().next();
        opening = first.value;
        yield textDelta("hello");
        yield turnEnded();
      },
    });
    await (await client.run({ prompt: "Say hello", modelId: "Composer" })).wait();
    expect(opening?.message.case).toBe("runRequest");
    if (opening?.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    expect(opening.message.value.requestedModel?.modelId).toBe("composer-2.5");
    client.close();
  });

  it("run forwards optional mode and customSystemPrompt on the opening request", async () => {
    let opening: AgentClientMessage | undefined;
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      fetch: async () => jsonResponse(200, { accessToken: "tok", refreshToken: "ref" }),
      bootstrapClients: bootstrapClients(),
      openRun: async function* (outbound) {
        const first = await outbound[Symbol.asyncIterator]().next();
        opening = first.value;
        yield textDelta("hello");
        yield turnEnded();
      },
    });
    await (
      await client.run({ prompt: "Say hello", mode: "agent", customSystemPrompt: "You are terse." })
    ).wait();
    expect(opening?.message.case).toBe("runRequest");
    if (opening?.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    expect(opening.message.value.customSystemPrompt).toBe("You are terse.");
    const action = opening.message.value.action?.action;
    if (action?.case !== "userMessageAction") {
      throw new Error("expected userMessageAction");
    }
    expect(action.value.userMessage?.mode).toBe(1);
    client.close();
  });

  it("run via openRun yields text_delta and completes wait", async () => {
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      fetch: async () => jsonResponse(200, { accessToken: "tok", refreshToken: "ref" }),
      bootstrapClients: bootstrapClients(),
      openRun: async function* () {
        yield textDelta("hello");
        yield turnEnded();
      },
    });
    const run = await client.run({ prompt: "Say hello" });
    const types: string[] = [];
    for await (const event of run) {
      types.push(event.type);
    }
    const result = await run.wait();
    expect(types).toContain("text_delta");
    expect(types).toContain("turn_ended");
    expect(result.text).toBe("hello");
    expect(result.usage.inputTokens).toBe(1);
    expect(result.usage.outputTokens).toBe(2);
    client.close();
  });

  it("throws TransportUnsupportedError when HTTP/1.1 is forced", async () => {
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      fetch: async () => jsonResponse(200, { accessToken: "tok", refreshToken: "ref" }),
      bootstrapClients: bootstrapClients({
        getServerConfig: async () =>
          create(GetServerConfigResponseSchema, {
            http2Config: Http2Config.FORCE_ALL_DISABLED,
          }),
      }),
    });
    await client.models();
    await expect(client.run({ prompt: "hi" })).rejects.toBeInstanceOf(TransportUnsupportedError);
    client.close();
  });
});

describe("README example", () => {
  it("compiles against public types", () => {
    const readmeAskExample: (apiKey: string) => Promise<string> = async (apiKey) => {
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
    };
    const handlers: DispatchHandlers = {
      onInteraction: (_query: InteractionQuery): AgentClientMessage | undefined => undefined,
    };
    expect(name).toBe("cursor-rpc");
    expect(typeof readmeAskExample).toBe("function");
    expect(typeof login).toBe("function");
    expect(typeof handlers.onInteraction).toBe("function");
  });
});
