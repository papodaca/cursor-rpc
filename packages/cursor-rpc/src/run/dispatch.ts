import { create } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ApprovalResultSchema,
  BlobErrorSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientThrowSchema,
  GetBlobResultSchema,
  InteractionResponseSchema,
  KvClientMessageSchema,
  RejectedSchema,
  RequestContextEnvSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  SetBlobResultSchema,
  WebFetchAllowlistPrecheckResultSchema,
  WebFetchRequestResponseSchema,
  WebSearchRequestResponseSchema,
  type AgentClientMessage,
  type AgentServerMessage,
  type ExecServerMessage,
  type InteractionQuery,
} from "../generated/agent/v1/agent_pb.js";

export type DispatchHandlers = {
  onInteraction?: (query: InteractionQuery) => Promise<AgentClientMessage | undefined> | AgentClientMessage | undefined;
  onExec?: (exec: ExecServerMessage) => Promise<AgentClientMessage | undefined> | AgentClientMessage | undefined;
};

export type InFlightExec = {
  abort: AbortController;
  replied: boolean;
};

export function replyRejected(id: number, reason = "User Rejected", queryCase?: InteractionQuery["query"]["case"]): AgentClientMessage {
  const rejected = create(RejectedSchema, { reason });
  const approval = create(ApprovalResultSchema, { result: { case: "rejected", value: rejected } });
  const webSearch = create(WebSearchRequestResponseSchema, { result: { case: "rejected", value: rejected } });
  const webFetch = create(WebFetchRequestResponseSchema, { result: { case: "rejected", value: rejected } });
  const result = (() => {
    switch (queryCase) {
      case "webSearchRequestQuery":
        return { case: "webSearchRequestResponse" as const, value: webSearch };
      case "webFetchRequestQuery":
        return { case: "webFetchRequestResponse" as const, value: webFetch };
      case "askQuestionInteractionQuery":
        return { case: "askQuestionInteractionResult" as const, value: approval };
      case "switchModeRequestQuery":
        return { case: "switchModeRequestResponse" as const, value: approval };
      case "createPlanRequestQuery":
        return { case: "createPlanRequestResponse" as const, value: approval };
      case "setupVmEnvironmentArgs":
        return { case: "setupVmEnvironmentResponse" as const, value: approval };
      case "prManagementRequestQuery":
        return { case: "prManagementRequestResponse" as const, value: approval };
      case "mcpAuthRequestQuery":
        return { case: "mcpAuthRequestResponse" as const, value: approval };
      case "generateImageRequestQuery":
        return { case: "generateImageRequestResponse" as const, value: approval };
      case "replaceEnvArgs":
        return { case: "replaceEnvResponse" as const, value: approval };
      case "connectScmRequestQuery":
        return { case: "connectScmRequestResponse" as const, value: approval };
      default:
        return { case: "webSearchRequestResponse" as const, value: webSearch };
    }
  })();
  return create(AgentClientMessageSchema, {
    message: {
      case: "interactionResponse",
      value: create(InteractionResponseSchema, { id, result }),
    },
  });
}

export function replyExecThrow(id: number, error = "tool not implemented"): AgentClientMessage {
  return create(AgentClientMessageSchema, {
    message: {
      case: "execClientControlMessage",
      value: create(ExecClientControlMessageSchema, {
        message: {
          case: "throw",
          value: create(ExecClientThrowSchema, { id, error }),
        },
      }),
    },
  });
}

export function defaultExecReply(exec: ExecServerMessage): AgentClientMessage {
  if (exec.message.case === "webFetchAllowlistPrecheckArgs") {
    return create(AgentClientMessageSchema, {
      message: {
        case: "execClientMessage",
        value: create(ExecClientMessageSchema, {
          id: exec.id,
          execId: exec.execId,
          message: {
            case: "webFetchAllowlistPrecheckResult",
            value: create(WebFetchAllowlistPrecheckResultSchema, { allowlisted: false }),
          },
        }),
      },
    });
  }
  if (exec.message.case === "requestContextArgs") {
    return create(AgentClientMessageSchema, {
      message: {
        case: "execClientMessage",
        value: create(ExecClientMessageSchema, {
          id: exec.id,
          execId: exec.execId,
          message: {
            case: "requestContextResult",
            value: create(RequestContextResultSchema, {
              requestContext: create(RequestContextSchema, {
                env: create(RequestContextEnvSchema, { workspacePaths: [] }),
              }),
            }),
          },
        }),
      },
    });
  }
  return replyExecThrow(exec.id);
}

export function defaultKvReply(server: AgentServerMessage): AgentClientMessage | undefined {
  if (server.message.case !== "kvServerMessage") {
    return undefined;
  }
  const kv = server.message.value;
  if (kv.message.case === "getBlobArgs") {
    return create(AgentClientMessageSchema, {
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kv.id,
          message: {
            case: "getBlobResult",
            value: create(GetBlobResultSchema, {
              error: create(BlobErrorSchema, { message: "blob not found" }),
            }),
          },
        }),
      },
    });
  }
  if (kv.message.case === "setBlobArgs") {
    return create(AgentClientMessageSchema, {
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kv.id,
          message: {
            case: "setBlobResult",
            value: create(SetBlobResultSchema, {}),
          },
        }),
      },
    });
  }
  return undefined;
}

function aborted(...signals: Array<AbortSignal | undefined>): Promise<undefined> {
  return new Promise((resolve) => {
    const onAbort = () => resolve(undefined);
    for (const signal of signals) {
      if (signal === undefined) {
        continue;
      }
      if (signal.aborted) {
        resolve(undefined);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export async function dispatchServerMessage(
  inbound: AgentServerMessage,
  options: {
    handlers?: DispatchHandlers;
    inFlight: Map<number, InFlightExec>;
    signal?: AbortSignal;
  },
): Promise<AgentClientMessage | undefined> {
  if (inbound.message.case === "interactionQuery") {
    const query = inbound.message.value;
    try {
      const custom = await options.handlers?.onInteraction?.(query);
      return custom ?? replyRejected(query.id, "User Rejected", query.query.case);
    } catch {
      return replyRejected(query.id, "User Rejected", query.query.case);
    }
  }
  if (inbound.message.case === "execServerMessage") {
    const exec = inbound.message.value;
    const flight = options.inFlight.get(exec.id) ?? { abort: new AbortController(), replied: false };
    options.inFlight.set(exec.id, flight);
    try {
      if (options.signal?.aborted || flight.abort.signal.aborted) {
        return defaultExecReply(exec);
      }
      const custom = await Promise.race([
        Promise.resolve(options.handlers?.onExec?.(exec)),
        aborted(flight.abort.signal, options.signal),
      ]);
      if (flight.abort.signal.aborted || options.signal?.aborted) {
        return replyExecThrow(exec.id, "aborted");
      }
      return custom ?? defaultExecReply(exec);
    } catch {
      return defaultExecReply(exec);
    } finally {
      flight.replied = true;
      options.inFlight.delete(exec.id);
    }
  }
  if (inbound.message.case === "kvServerMessage") {
    return defaultKvReply(inbound);
  }
  if (inbound.message.case === "execServerControlMessage" && inbound.message.value.message.case === "abort") {
    const id = inbound.message.value.message.value.id;
    options.inFlight.get(id)?.abort.abort();
    return undefined;
  }
  return undefined;
}
