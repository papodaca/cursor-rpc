import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "../src/credentials.ts";
import { AuthSession } from "../src/auth/session.ts";
import { AuthenticationError, CancelledError, StreamError } from "../src/errors.ts";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerControlMessageSchema,
  ExecServerMessageSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/generated/agent/v1/agent_pb.ts";
import { AsyncQueue } from "../src/run/queue.ts";
import { DEFAULT_EXCLUDE_TOOLS, openingRunRequest, runHeaders, runTurn } from "../src/run/run.ts";
import type { AgentClientMessage, AgentServerMessage } from "../src/generated/agent/v1/agent_pb.ts";

function textDelta(text: string, isServerNotice = false): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "textDelta",
          value: create(TextDeltaUpdateSchema, { text, isServerNotice }),
        },
      }),
    },
  });
}

function turnEnded(inputTokens = 1, outputTokens = 2): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "turnEnded",
          value: create(TurnEndedUpdateSchema, { inputTokens, outputTokens }),
        },
      }),
    },
  });
}

describe("run turn", () => {
  it("default run headers exclude web_search_tool_call and web_fetch_tool_call until opted in", () => {
    const excluded = runHeaders();
    expect(excluded.get("x-cursor-agent-exclude-tools")).toContain("web_search_tool_call");
    expect(excluded.get("x-cursor-agent-exclude-tools")).toContain("web_fetch_tool_call");
    for (const name of DEFAULT_EXCLUDE_TOOLS) {
      expect(excluded.get("x-cursor-agent-exclude-tools")).toContain(name);
    }
    const opted = runHeaders({ allowWebSearch: true, allowWebFetch: true });
    expect(opted.has("x-cursor-agent-exclude-tools")).toBe(false);
  });

  it("completes an ASK turn with no handlers when an interaction_query arrives", async () => {
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
    });
    inbound.push(
      create(AgentServerMessageSchema, {
        message: { case: "interactionQuery", value: create(InteractionQuerySchema, { id: 7 }) },
      }),
    );
    inbound.push(textDelta("ok"));
    inbound.push(turnEnded());
    inbound.close();
    const result = await handle.wait();
    expect(result.text).toBe("ok");
    expect(result.usage.inputTokens).toBe(1);
    expect(result.usage.outputTokens).toBe(2);
    expect(outbound.some((message) => message.message.case === "interactionResponse")).toBe(true);
  });

  it("yields server notices separately from assistant text", async () => {
    const inbound = new AsyncQueue<AgentServerMessage>();
    const handle = runTurn({
      prompt: "hi",
      inbound,
      send: () => undefined,
      heartbeatMs: 60_000,
      stallMs: 60_000,
    });
    inbound.push(textDelta("quota", true));
    inbound.push(textDelta("hello"));
    inbound.push(turnEnded());
    inbound.close();
    const result = await handle.wait();
    expect(result.events.map((event) => event.type)).toContain("server_notice");
    expect(result.text).toBe("hello");
  });

  it("KV get without a store returns an error result and set acks", async () => {
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
    });
    inbound.push(
      create(AgentServerMessageSchema, {
        message: {
          case: "kvServerMessage",
          value: create(KvServerMessageSchema, {
            id: 1,
            message: { case: "getBlobArgs", value: { blobId: new Uint8Array([1]) } },
          }),
        },
      }),
    );
    inbound.push(
      create(AgentServerMessageSchema, {
        message: {
          case: "kvServerMessage",
          value: create(KvServerMessageSchema, {
            id: 2,
            message: { case: "setBlobArgs", value: { blobId: new Uint8Array([1]), blobData: new Uint8Array([2]) } },
          }),
        },
      }),
    );
    inbound.push(turnEnded());
    inbound.close();
    await handle.wait();
    const kv = outbound.filter((message) => message.message.case === "kvClientMessage");
    expect(kv).toHaveLength(2);
    expect(JSON.stringify(kv[0])).toMatch(/blob not found|error/i);
  });

  it("aborts in-flight exec on exec_server_control and still sends one reply", async () => {
    const inbound = new AsyncQueue<AgentServerMessage>();
    const outbound: AgentClientMessage[] = [];
    let release: (() => void) | undefined;
    const handle = runTurn({
      prompt: "hi",
      inbound,
      send: (message) => {
        outbound.push(message);
      },
      heartbeatMs: 60_000,
      stallMs: 60_000,
      handlers: {
        onExec: () =>
          new Promise((resolve) => {
            release = () => resolve(create(AgentClientMessageSchema, {}));
          }),
      },
    });
    inbound.push(
      create(AgentServerMessageSchema, {
        message: {
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, { id: 11, execId: "exec-11" }),
        },
      }),
    );
    inbound.push(
      create(AgentServerMessageSchema, {
        message: {
          case: "execServerControlMessage",
          value: create(ExecServerControlMessageSchema, {
            message: { case: "abort", value: { id: 11 } },
          }),
        },
      }),
    );
    inbound.push(turnEnded());
    inbound.close();
    await handle.wait();
    release?.();
    const throws = outbound.filter((message) => message.message.case === "execClientControlMessage");
    expect(throws.length).toBeGreaterThanOrEqual(1);
  });

  it("aborts after silence with stall code and does not clear the store", async () => {
    const store = new MemoryCredentialStore();
    const auth = new AuthSession({ apiUrl: "https://api2.cursor.sh", store, authToken: "tok" });
    const inbound = new AsyncQueue<AgentServerMessage>();
    const handle = runTurn({
      prompt: "hi",
      inbound,
      send: () => undefined,
      heartbeatMs: 60_000,
      stallMs: 20,
    });
    await expect(handle.wait()).rejects.toBeInstanceOf(StreamError);
    await expect(handle.wait()).rejects.toMatchObject({ isRetryable: true, code: "deadline_exceeded" });
    expect(store.load()?.accessToken).toBe("tok");
  });

  it("iterator break stops heartbeats", async () => {
    const inbound = new AsyncQueue<AgentServerMessage>();
    let heartbeats = 0;
    const handle = runTurn({
      prompt: "hi",
      inbound,
      send: (message) => {
        if (message.message.case === "clientHeartbeat") {
          heartbeats += 1;
        }
      },
      heartbeatMs: 20,
      stallMs: 60_000,
    });
    void handle.wait().catch(() => undefined);
    const iterator = handle[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    const afterReturn = heartbeats;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(heartbeats).toBe(afterReturn);
    inbound.close();
  });

  it("abort during an in-flight handler still sends one reply", async () => {
    const inbound = new AsyncQueue<AgentServerMessage>();
    const outbound: AgentClientMessage[] = [];
    let started!: () => void;
    const startedAt = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handle = runTurn({
      prompt: "hi",
      inbound,
      send: (message) => {
        outbound.push(message);
      },
      heartbeatMs: 60_000,
      stallMs: 60_000,
      handlers: {
        onExec: () => {
          started();
          return new Promise(() => undefined);
        },
      },
    });
    inbound.push(
      create(AgentServerMessageSchema, {
        message: {
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, { id: 21, execId: "exec-21" }),
        },
      }),
    );
    await startedAt;
    handle.abort();
    inbound.close();
    await expect(handle.wait()).rejects.toBeInstanceOf(CancelledError);
    expect(outbound.filter((message) => message.message.case === "execClientControlMessage").length).toBeGreaterThanOrEqual(1);
  });

  it("abort during stream tears down and rejects wait", async () => {
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
    });
    handle.abort();
    inbound.close();
    await expect(handle.wait()).rejects.toBeInstanceOf(CancelledError);
    expect(
      outbound.some((message) => {
        if (message.message.case !== "conversationAction") {
          return false;
        }
        return message.message.value.action.case === "cancelAction";
      }),
    ).toBe(true);
  });

  it("mid-stream Unauthenticated clears the store, rejects wait, and does not start another Run", async () => {
    const store = new MemoryCredentialStore();
    const auth = new AuthSession({ apiUrl: "https://api2.cursor.sh", store, authToken: "tok" });
    const inbound = new AsyncQueue<AgentServerMessage>();
    let sends = 0;
    const handle = runTurn({
      prompt: "hi",
      inbound,
      send: () => {
        sends += 1;
      },
      heartbeatMs: 60_000,
      stallMs: 60_000,
      onUnauthenticated: (error) => {
        auth.handleAuthFailure(error, true);
      },
    });
    inbound.close(new ConnectError("expired", Code.Unauthenticated));
    await expect(handle.wait()).rejects.toBeInstanceOf(AuthenticationError);
    expect(store.load()).toBeUndefined();
    expect(sends).toBe(1);
  });

  it("opening run_request uses ASK, empty workspace_paths, and omits file_contents", () => {
    const opening = openingRunRequest("hello");
    expect(opening.message.case).toBe("runRequest");
    if (opening.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    const action = opening.message.value.action?.action;
    expect(action?.case).toBe("userMessageAction");
    if (action?.case !== "userMessageAction") {
      throw new Error("expected userMessageAction");
    }
    expect(action.value.userMessage?.mode).toBe(2);
    expect(action.value.requestContext?.env?.workspacePaths).toEqual([]);
    expect(action.value.requestContext?.fileContents).toEqual({});
    expect(opening.message.value.excludeWorkspaceContext).toBe(true);
  });

  it("second turn history omits conversationState blobs", async () => {
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
    const second = openingRunRequest("second", history);
    expect(JSON.stringify(history)).toContain("first");
    expect(JSON.stringify(history)).toContain("reply");
    expect(JSON.stringify(history)).not.toMatch(/conversationStateBlob/);
    if (second.message.case !== "runRequest") {
      throw new Error("expected runRequest");
    }
    expect(second.message.value.action?.action.case).toBe("userMessageAction");
  });
});
