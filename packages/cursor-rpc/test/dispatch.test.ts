import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  InteractionQuerySchema,
} from "../src/generated/agent/v1/agent_pb.ts";
import { defaultExecReply, dispatchServerMessage, replyRejected } from "../src/run/dispatch.ts";

describe("run dispatcher", () => {
  it("rejects an unknown interaction_query with the echoed id", async () => {
    const inbound = create(AgentServerMessageSchema, {
      message: {
        case: "interactionQuery",
        value: create(InteractionQuerySchema, { id: 9 }),
      },
    });
    const reply = await dispatchServerMessage(inbound, { inFlight: new Map() });
    expect(reply?.message.case).toBe("interactionResponse");
    if (reply?.message.case !== "interactionResponse") {
      throw new Error("expected interactionResponse");
    }
    expect(reply.message.value.id).toBe(9);
    expect(JSON.stringify(reply)).toMatch(/rejected/i);
  });

  it("replies allowlisted false for fetch precheck without a handler", async () => {
    const inbound = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: 3,
          execId: "exec-3",
          message: {
            case: "webFetchAllowlistPrecheckArgs",
            value: { url: "https://example.com", toolCallId: "tool-1" },
          },
        }),
      },
    });
    const reply = await dispatchServerMessage(inbound, { inFlight: new Map() });
    expect(reply?.message.case).toBe("execClientMessage");
    if (reply?.message.case !== "execClientMessage") {
      throw new Error("expected execClientMessage");
    }
    expect(reply.message.value.id).toBe(3);
    expect(reply.message.value.execId).toBe("exec-3");
    expect(reply.message.value.message.case).toBe("webFetchAllowlistPrecheckResult");
    if (reply.message.value.message.case !== "webFetchAllowlistPrecheckResult") {
      throw new Error("expected precheck result");
    }
    expect(reply.message.value.message.value.allowlisted).toBe(false);
  });

  it("uses throw for unimplemented exec and still answers", () => {
    const exec = create(ExecServerMessageSchema, { id: 4, execId: "e4" });
    const reply = defaultExecReply(exec);
    expect(reply.message.case).toBe("execClientControlMessage");
  });

  it("still sends one reply when a caller handler throws", async () => {
    const inbound = create(AgentServerMessageSchema, {
      message: {
        case: "interactionQuery",
        value: create(InteractionQuerySchema, {
          id: 2,
          query: {
            case: "webSearchRequestQuery",
            value: { args: { searchTerm: "q", toolCallId: "t" } },
          },
        }),
      },
    });
    const reply = await dispatchServerMessage(inbound, {
      inFlight: new Map(),
      handlers: {
        onInteraction: () => {
          throw new Error("handler boom");
        },
      },
    });
    expect(reply?.message.case).toBe("interactionResponse");
    expect(replyRejected(2, "User Rejected", "webSearchRequestQuery").message.case).toBe("interactionResponse");
  });
});
