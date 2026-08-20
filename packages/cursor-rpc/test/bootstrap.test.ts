import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { TransportUnsupportedError } from "../src/errors.ts";
import { PrivacyMode, GetUserPrivacyModeResponseSchema } from "../src/generated/aiserver/v1/dashboard_pb.ts";
import {
  AvailableModelsResponseSchema,
  GetDefaultModelForCliResponseSchema,
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/generated/aiserver/v1/models_pb.ts";
import { GetServerConfigResponseSchema, Http2Config } from "../src/generated/aiserver/v1/server_config_pb.ts";
import { bootstrap, type BootstrapClients } from "../src/session/bootstrap.ts";
import { assertRunTransport, parseAgentUrlConfig, privacyProbeUrl, selectAgentBaseUrl } from "../src/session/host.ts";

const MODEL = create(ModelDetailsSchema, { modelId: "composer-2.5", displayName: "Composer" });

function clients(overrides: Partial<BootstrapClients> = {}): BootstrapClients {
  return {
    getServerConfig: async () =>
      create(GetServerConfigResponseSchema, {
        http2Config: Http2Config.FORCE_ALL_ENABLED,
        agentUrlConfig: { agentUrl: "https://agent-ghost.example", agentnUrl: "https://agent-nonghost.example" },
      }),
    getUserPrivacyMode: async () => create(GetUserPrivacyModeResponseSchema, { privacyMode: PrivacyMode.NO_TRAINING }),
    getUsableModels: async () => create(GetUsableModelsResponseSchema, { models: [MODEL] }),
    getDefaultModelForCli: async () => create(GetDefaultModelForCliResponseSchema, { model: MODEL }),
    availableModels: async () => create(AvailableModelsResponseSchema, { models: [] }),
    ...overrides,
  };
}

describe("bootstrap and host selection", () => {
  it("selects agent_url when ghost mode is true and both agent URLs parse", async () => {
    const session = await bootstrap({
      apiUrl: "https://api2.cursor.sh",
      getAccessToken: async () => "tok",
      clients: clients(),
    });
    expect(session.ghostMode).toBe(true);
    expect(session.agentBaseUrl).toBe("https://agent-ghost.example");
    expect(session.models.models[0]?.modelId).toBe("composer-2.5");
    await expect(session.getAccessToken()).resolves.toBe("tok");
  });

  it("selects the API origin as agent host when HTTP/1.1 is forced and still blocks Run", async () => {
    const session = await bootstrap({
      apiUrl: "https://api2.cursor.sh",
      getAccessToken: async () => "tok",
      clients: clients({
        getServerConfig: async () =>
          create(GetServerConfigResponseSchema, {
            http2Config: Http2Config.FORCE_ALL_DISABLED,
            agentUrlConfig: { agentUrl: "https://agent-ghost.example", agentnUrl: "https://agent-nonghost.example" },
          }),
      }),
    });
    expect(session.agentBaseUrl).toBe("https://api2.cursor.sh");
    expect(session.http2.usingHttp1).toBe(true);
    expect(session.http2.reasonTag).toBe("server_force_all_disabled");
    expect(() => assertRunTransport(session.http2)).toThrow(TransportUnsupportedError);
  });

  it("discards agent_url_config when either URL is file: or has userinfo", () => {
    expect(parseAgentUrlConfig({ agentUrl: "file:///tmp", agentnUrl: "https://ok.example" })).toBeUndefined();
    expect(
      parseAgentUrlConfig({ agentUrl: "https://user:pass@agent.example", agentnUrl: "https://ok.example" }),
    ).toBeUndefined();
    expect(parseAgentUrlConfig({ agentUrl: "not a url", agentnUrl: "also bad" })).toBeUndefined();
  });

  it("leaves ghost true when privacy fails, NO_TRAINING is ghost true, training-allowed is ghost false", async () => {
    const failed = await bootstrap({
      apiUrl: "https://api2.cursor.sh",
      getAccessToken: async () => "tok",
      clients: clients({
        getUserPrivacyMode: async () => {
          throw new Error("privacy down");
        },
      }),
    });
    expect(failed.ghostMode).toBe(true);

    const training = await bootstrap({
      apiUrl: "https://api2.cursor.sh",
      getAccessToken: async () => "tok",
      clients: clients({
        getUserPrivacyMode: async () =>
          create(GetUserPrivacyModeResponseSchema, { privacyMode: PrivacyMode.USAGE_DATA_TRAINING_ALLOWED }),
      }),
    });
    expect(training.ghostMode).toBe(false);
    expect(training.agentBaseUrl).toBe("https://agent-nonghost.example");
  });

  it("rewrites privacy RPC bases ending in cursor.sh without changing other RPC bases", async () => {
    const seen: string[] = [];
    await bootstrap({
      apiUrl: "https://staging.cursor.sh",
      getAccessToken: async () => "tok",
      clients: clients({
        getUserPrivacyMode: async (baseUrl) => {
          seen.push(baseUrl);
          return create(GetUserPrivacyModeResponseSchema, { privacyMode: PrivacyMode.NO_TRAINING });
        },
      }),
    });
    expect(seen).toEqual(["https://api2.cursor.sh"]);
    expect(privacyProbeUrl("https://staging.cursor.sh")).toBe("https://api2.cursor.sh");
    expect(selectAgentBaseUrl("https://staging.cursor.sh", true, undefined, false)).toBe("https://staging.cursor.sh");
  });
});
