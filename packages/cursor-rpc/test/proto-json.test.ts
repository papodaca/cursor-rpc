import { fromJson, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AgentClientMessageSchema, AgentServerMessageSchema, AgentService } from "../src/generated/agent/v1/agent_pb.ts";
import {
  AiService,
  RunWebFetchResponseSchema,
  RunWebSearchResponseSchema,
} from "../src/generated/aiserver/v1/ai_pb.ts";
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
    expect(AiService.method.runWebFetch.name).toBe("RunWebFetch");
    expect(AiService.method.runWebFetch.methodKind).toBe("unary");
    expect(AiService.method.runWebSearch.name).toBe("RunWebSearch");
    expect(AiService.method.runWebSearch.methodKind).toBe("unary");
  });

  it("round-trips RunWebFetch success content and search documents with answer", () => {
    const fetchSuccess = fromJson(RunWebFetchResponseSchema, {
      success: { content: "# Hello" },
    });
    expect(fetchSuccess.result.case).toBe("success");
    if (fetchSuccess.result.case !== "success") {
      throw new Error("expected success");
    }
    expect(fetchSuccess.result.value.content).toBe("# Hello");
    expect(toJson(RunWebFetchResponseSchema, fetchSuccess)).toEqual({
      success: { content: "# Hello" },
    });

    const search = fromJson(RunWebSearchResponseSchema, {
      answer: "summary",
      documents: [{ url: "https://example.com", title: "Example", text: "chunk" }],
    });
    expect(search.answer).toBe("summary");
    expect(search.documents).toHaveLength(1);
    expect(search.documents[0]?.url).toBe("https://example.com");
    expect(search.documents[0]?.title).toBe("Example");
    expect(search.documents[0]?.text).toBe("chunk");
    expect(toJson(RunWebSearchResponseSchema, search)).toEqual({
      answer: "summary",
      documents: [{ url: "https://example.com", title: "Example", text: "chunk" }],
    });
  });

  it("ignores an unknown JSON field on RunWebFetchResponse", () => {
    const message = fromJson(
      RunWebFetchResponseSchema,
      {
        success: { content: "ok" },
        unexpectedFutureField: { nested: true },
      },
      { ignoreUnknownFields: true },
    );
    expect(message.result.case).toBe("success");
    expect(toJson(RunWebFetchResponseSchema, message)).not.toHaveProperty("unexpectedFutureField");
  });

  it("round-trips RunWebFetch error with is_timeout", () => {
    const message = fromJson(RunWebFetchResponseSchema, {
      error: { error: "timed out", isTimeout: true },
    });
    expect(message.result.case).toBe("error");
    if (message.result.case !== "error") {
      throw new Error("expected error");
    }
    expect(message.result.value.error).toBe("timed out");
    expect(message.result.value.isTimeout).toBe(true);
    expect(toJson(RunWebFetchResponseSchema, message)).toEqual({
      error: { error: "timed out", isTimeout: true },
    });
  });
});
