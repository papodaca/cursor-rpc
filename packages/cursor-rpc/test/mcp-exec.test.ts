import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  type AgentClientMessage,
  type AgentServerMessage,
} from "../src/generated/agent/v1/agent_pb.ts";
import { createClient } from "../src/client.ts";
import { MemoryCredentialStore } from "../src/credentials.ts";
import { dispatchServerMessage, replyMcpResult } from "../src/run/dispatch.ts";
import { AsyncQueue } from "../src/run/queue.ts";
import { DEFAULT_EXCLUDE_TOOLS, openingRunRequest, runHeaders, runTurn } from "../src/run/run.ts";
import { GetServerConfigResponseSchema, Http2Config } from "../src/generated/aiserver/v1/server_config_pb.ts";
import { PrivacyMode, GetUserPrivacyModeResponseSchema } from "../src/generated/aiserver/v1/dashboard_pb.ts";
import {
  GetDefaultModelForCliResponseSchema,
  GetUsableModelsResponseSchema,
  ModelDetailsSchema,
} from "../src/generated/aiserver/v1/models_pb.ts";
import type { BootstrapClients } from "../src/session/bootstrap.ts";

const MODEL = create(ModelDetailsSchema, { modelId: "composer-2.5", displayName: "Composer" });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bootstrapClients(): BootstrapClients {
  return {
    getServerConfig: async () =>
      create(GetServerConfigResponseSchema, {
        http2Config: Http2Config.FORCE_ALL_ENABLED,
      }),
    getUserPrivacyMode: async () => create(GetUserPrivacyModeResponseSchema, { privacyMode: PrivacyMode.NO_TRAINING }),
    getUsableModels: async () => create(GetUsableModelsResponseSchema, { models: [MODEL] }),
    getDefaultModelForCli: async () => create(GetDefaultModelForCliResponseSchema, { model: MODEL }),
    availableModels: async () => ({ models: [] }),
  };
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

function textDelta(text: string): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) },
      }),
    },
  });
}

function mcpArgValues(args: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, fromJson(ValueSchema, value)]));
}

function mcpExec(id: number, execId: string, toolName: string, args: Record<string, string>): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id,
        execId,
        message: {
          case: "mcpArgs",
          value: create(McpArgsSchema, {
            name: toolName,
            toolName,
            toolCallId: `call-${id}`,
            args: mcpArgValues(args),
          }),
        },
      }),
    },
  });
}

describe("MCP exec surface", () => {
  it("run({ mcpTools }) accepts a plain DTO, serializes mcp_tools, and allowlists mcp_tool_call", async () => {
    let capturedHeaders: Headers | undefined;
    let opening: AgentClientMessage | undefined;
    const outboundSeen = new AsyncQueue<AgentClientMessage>();
    const client = createClient({
      apiKey: "key_live_test",
      env: {},
      store: new MemoryCredentialStore(),
      fetch: async () => jsonResponse(200, { accessToken: "tok", refreshToken: "ref" }),
      bootstrapClients: bootstrapClients(),
      openRun: (outbound, options) => {
        capturedHeaders = options.headers;
        void (async () => {
          for await (const message of outbound) {
            outboundSeen.push(message);
          }
          outboundSeen.close();
        })();
        return (async function* () {
          yield turnEnded();
        })();
      },
    });
    const tool = { name: "read_file", description: "Read a file", inputSchemaJson: '{"type":"object"}' };
    const handle = await client.run({ prompt: "read it", mcpTools: [tool] });
    await handle.wait();
    opening = await outboundSeen[Symbol.asyncIterator]().next().then((result) => result.value);
    expect(tool).not.toHaveProperty("$typeName");
    expect(capturedHeaders?.get("x-cursor-agent-allowed-tools")).toContain("mcp_tool_call");
    expect(opening?.message.case).toBe("runRequest");
    if (opening?.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    const tools = opening.message.value.mcpTools?.mcpTools ?? [];
    expect(tools.map((entry) => entry.name)).toEqual(["read_file"]);
    expect(tools[0]?.inputSchemaJson).toBe('{"type":"object"}');
    expect(opening.message.value.action?.action.case).toBe("userMessageAction");
    if (opening.message.value.action?.action.case !== "userMessageAction") {
      throw new Error("expected userMessageAction");
    }
    expect(opening.message.value.action.action.value.userMessage?.mode).toBe(1);
    client.close();
  });

  it("no mcpTools keeps ASK defaults and web-tool exclude headers", () => {
    const headers = runHeaders();
    expect(headers.get("x-cursor-agent-exclude-tools")).toContain("web_search_tool_call");
    expect(headers.get("x-cursor-agent-exclude-tools")).toContain("web_fetch_tool_call");
    for (const name of DEFAULT_EXCLUDE_TOOLS) {
      expect(headers.get("x-cursor-agent-exclude-tools")).toContain(name);
    }
    expect(headers.has("x-cursor-agent-allowed-tools")).toBe(false);
    const opening = openingRunRequest("hello");
    if (opening.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    expect(opening.message.value.mcpTools).toBeUndefined();
    const action = opening.message.value.action?.action;
    if (action?.case !== "userMessageAction") {
      throw new Error("expected userMessageAction");
    }
    expect(action.value.userMessage?.mode).toBe(2);
  });

  it("inbound mcp_args with a handler sends mcp_result field 11 and yields a typed MCP event", async () => {
    const inbound = new AsyncQueue<AgentServerMessage>();
    const outbound: AgentClientMessage[] = [];
    const handle = runTurn({
      prompt: "hi",
      inbound,
      send: (message) => {
        outbound.push(message);
      },
      heartbeatMs: 60_000,
      stallMs: 60_000,
      handlers: {
        onExec: (exec) => replyMcpResult(exec.id, exec.execId, { text: "handed-off" }),
      },
    });
    inbound.push(mcpExec(8, "exec-8", "read_file", { path: "/tmp/x" }));
    inbound.push(textDelta("done"));
    inbound.push(turnEnded());
    inbound.close();
    const result = await handle.wait();
    const mcp = result.events.find((event) => event.type === "mcp_exec");
    expect(mcp).toMatchObject({
      type: "mcp_exec",
      id: 8,
      execId: "exec-8",
      name: "read_file",
    });
    if (mcp?.type === "mcp_exec") {
      expect(JSON.parse(mcp.argumentsJson)).toMatchObject({ path: "/tmp/x" });
    }
    const reply = outbound.find((message) => message.message.case === "execClientMessage");
    expect(reply?.message.case).toBe("execClientMessage");
    if (reply?.message.case !== "execClientMessage") {
      throw new Error("expected execClientMessage");
    }
    expect(reply.message.value.id).toBe(8);
    expect(reply.message.value.execId).toBe("exec-8");
    expect(reply.message.value.message.case).toBe("mcpResult");
  });

  it("inbound mcp_args with no handler still sends exactly one throw and does not hang", async () => {
    const inbound = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: 11,
          execId: "exec-11",
          message: {
            case: "mcpArgs",
            value: create(McpArgsSchema, { name: "read_file", toolName: "read_file" }),
          },
        }),
      },
    });
    const reply = await dispatchServerMessage(inbound, { inFlight: new Map() });
    expect(reply?.message.case).toBe("execClientControlMessage");
    if (reply?.message.case !== "execClientControlMessage") {
      throw new Error("expected throw");
    }
    expect(reply.message.value.message.case).toBe("throw");
    if (reply.message.value.message.case !== "throw") {
      throw new Error("expected throw");
    }
    expect(reply.message.value.message.value.id).toBe(11);
  });

  it("unimplemented shell exec remains a throw", async () => {
    const inbound = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, { id: 4, execId: "e4" }),
      },
    });
    const reply = await dispatchServerMessage(inbound, { inFlight: new Map() });
    expect(reply?.message.case).toBe("execClientControlMessage");
    if (reply?.message.case !== "execClientControlMessage") {
      throw new Error("expected throw");
    }
    expect(reply.message.value.message.case).toBe("throw");
  });

  it("second run with conversationHistory omits checkpoint blobs", async () => {
    const inbound = new AsyncQueue<AgentServerMessage>();
    const handle = runTurn({
      prompt: "first",
      inbound,
      send: () => undefined,
      heartbeatMs: 60_000,
      stallMs: 60_000,
    });
    inbound.push(textDelta("reply"));
    inbound.push(turnEnded());
    inbound.close();
    await handle.wait();
    const history = handle.conversationHistory();
    const second = openingRunRequest("second", history, {
      conversationId: "11111111-1111-1111-1111-111111111111",
      runId: "22222222-2222-2222-2222-222222222222",
    });
    expect(JSON.stringify(history)).not.toMatch(/conversationStateBlob/);
    if (second.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    expect(second.message.value.conversationId).toBe("11111111-1111-1111-1111-111111111111");
    expect(second.message.value.runId).toBe("22222222-2222-2222-2222-222222222222");
    expect(JSON.stringify(history)).not.toMatch(/conversationStateBlob/);
    expect(second.message.value.preFetchedBlobs).toEqual([]);
  });
});
