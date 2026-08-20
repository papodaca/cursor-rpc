import { fromJson, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AgentClientMessageSchema, AgentServerMessageSchema, AgentService } from "../src/generated/agent/v1/agent_pb.ts";
import { AiService } from "../src/generated/aiserver/v1/ai_pb.ts";
import { DashboardService } from "../src/generated/aiserver/v1/dashboard_pb.ts";
import {
  GetServerConfigResponseSchema,
  Http2Config,
  ServerConfigService,
} from "../src/generated/aiserver/v1/server_config_pb.ts";

describe("proto JSON fixtures", () => {
  it("round-trips AgentClientMessage with runRequest", () => {
    const json = {
      runRequest: {
        conversationId: "11111111-1111-1111-1111-111111111111",
        excludeWorkspaceContext: true,
        action: {
          userMessageAction: {
            userMessage: {
              text: "hello",
              messageId: "22222222-2222-2222-2222-222222222222",
              mode: "AGENT_MODE_ASK",
            },
            requestContext: {
              env: { workspacePaths: [] },
            },
          },
        },
      },
    };
    const message = fromJson(AgentClientMessageSchema, json);
    expect(message.message.case).toBe("runRequest");
    if (message.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    expect(message.message.value.conversationId).toBe("11111111-1111-1111-1111-111111111111");
    expect(message.message.value.excludeWorkspaceContext).toBe(true);
    expect(message.message.value.action?.action.case).toBe("userMessageAction");
    const roundTrip = toJson(AgentClientMessageSchema, message);
    expect(roundTrip).toMatchObject({
      runRequest: {
        conversationId: json.runRequest.conversationId,
        excludeWorkspaceContext: true,
        action: {
          userMessageAction: {
            userMessage: json.runRequest.action.userMessageAction.userMessage,
          },
        },
      },
    });
  });

  it("round-trips AgentClientMessage with clientHeartbeat", () => {
    const json = { clientHeartbeat: {} };
    const message = fromJson(AgentClientMessageSchema, json);
    expect(message.message.case).toBe("clientHeartbeat");
    expect(toJson(AgentClientMessageSchema, message)).toEqual({ clientHeartbeat: {} });
  });

  it("ignores an unknown JSON field on GetServerConfigResponse", () => {
    const message = fromJson(
      GetServerConfigResponseSchema,
      {
        http2Config: "HTTP2_CONFIG_FORCE_ALL_ENABLED",
        unexpectedFutureField: { nested: true },
      },
      { ignoreUnknownFields: true },
    );
    expect(message.http2Config).toBe(Http2Config.FORCE_ALL_ENABLED);
    expect(toJson(GetServerConfigResponseSchema, message)).not.toHaveProperty("unexpectedFutureField");
  });

  it("decodes ttftBreakdown alongside interactionUpdate", () => {
    const message = fromJson(AgentServerMessageSchema, {
      interactionUpdate: {
        textDelta: { text: "hi", isServerNotice: false },
      },
      ttftBreakdown: {
        serverFirstTokenMs: 12.5,
        preStreamSetupMs: 1,
        waitForFirstEventMs: 2,
        slowPoolWaitMs: 0,
      },
    });
    expect(message.message.case).toBe("interactionUpdate");
    expect(message.ttftBreakdown?.serverFirstTokenMs).toBe(12.5);
    if (message.message.case !== "interactionUpdate") {
      throw new Error("expected interactionUpdate");
    }
    expect(message.message.value.message.case).toBe("textDelta");
  });

  it("fails closed on an invalid enum string", () => {
    expect(() =>
      fromJson(GetServerConfigResponseSchema, {
        http2Config: "HTTP2_CONFIG_NOT_A_REAL_VALUE",
      }),
    ).toThrow(/HTTP2_CONFIG_NOT_A_REAL_VALUE|invalid/i);
  });

  it("exposes generated DescService objects", () => {
    expect(ServerConfigService.typeName).toBe("aiserver.v1.ServerConfigService");
    expect(DashboardService.typeName).toBe("aiserver.v1.DashboardService");
    expect(AiService.typeName).toBe("aiserver.v1.AiService");
    expect(AgentService.typeName).toBe("agent.v1.AgentService");
    expect(AgentService.method.run.name).toBe("Run");
  });
});
