import { randomUUID } from "node:crypto";
import {
  AuthenticationError,
  CancelledError,
  conversationHistoryFromTurns,
  replyMcpResult,
  StreamError,
  TransportUnsupportedError,
  type HistoryTurn,
  type RunEvent,
} from "cursor-rpc";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { clientForStream, dropAfterAuthError, type ClientEpoch } from "./auth.js";
import { redactSecrets } from "./overflow.js";
import { emptyAssistant } from "./stream-stub.js";
import type {
  AssistantMessageEventStream,
  PiAssistantMessage,
  PiContext,
  PiMessage,
  PiModel,
  PiText,
  PiThinking,
  PiToolCall,
  SimpleStreamOptions,
} from "./types.js";

export function streamCursor(
  epoch: ClientEpoch,
  model: PiModel,
  context: PiContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream() as AssistantMessageEventStream;
  const output = emptyAssistant(model);
  output.api = model.api;

  void (async () => {
    stream.push({ type: "start", partial: output });
    const client = clientForStream(epoch, options);
    if (client === undefined) {
      fail(stream, output, options, "authentication required");
      return;
    }
    try {
      const tools = context.tools ?? [];
      const advertised = new Set(tools.map((tool) => tool.name));
      const conversationId = randomUUID();
      const runId = randomUUID();
      const mcpCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
      let mcpSeen = false;
      let cancelled = false;
      const handle = await client.run({
        prompt: latestUserText(context),
        customSystemPrompt: context.systemPrompt,
        conversationHistory: conversationHistoryFromTurns(historyTurns(context.messages)),
        conversationId,
        runId,
        maxTokens: options?.maxTokens,
        modelId: model.id,
        mode: tools.length > 0 ? "agent" : "ask",
        mcpTools:
          tools.length > 0
            ? tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchemaJson: JSON.stringify(tool.parameters ?? { type: "object" }),
              }))
            : undefined,
        signal: options?.signal,
        handlers: {
          onExec: (exec) => {
            if (exec.message.case !== "mcpArgs") {
              return undefined;
            }
            mcpSeen = true;
            return replyMcpResult(exec.id, exec.execId, { text: "handed-off" });
          },
        },
      });
      try {
        for await (const event of handle) {
          if (options?.signal?.aborted) {
            handle.abort();
            fail(stream, output, options, "aborted");
            return;
          }
          applyRunEvent(event, output, stream, advertised, mcpCalls);
          if (mcpSeen && !cancelled) {
            cancelled = true;
            handle.abort();
          }
        }
      } catch (error) {
        if (mcpCalls.length > 0 && !options?.signal?.aborted) {
          finishToolUse(stream, output, mcpCalls);
          if (!cancelled) {
            handle.abort();
          }
          return;
        }
        if (!cancelled) {
          handle.abort();
        }
        dropAfterAuthError(epoch, error);
        fail(stream, output, options, error);
        return;
      }
      if (mcpCalls.length > 0) {
        finishToolUse(stream, output, mcpCalls);
        if (!cancelled) {
          handle.abort();
        }
        return;
      }
      if (mcpSeen && !cancelled) {
        handle.abort();
      }
      if (output.stopReason === "pending") {
        output.stopReason = "stop";
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      dropAfterAuthError(epoch, error);
      fail(stream, output, options, error);
    }
  })();

  return stream;
}

function applyRunEvent(
  event: RunEvent,
  output: PiAssistantMessage,
  stream: AssistantMessageEventStream,
  advertised: Set<string>,
  mcpCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): void {
  if (event.type === "text_delta") {
    appendText(output, stream, event.text);
    return;
  }
  if (event.type === "thinking_delta") {
    appendThinking(output, stream, event.text);
    return;
  }
  if (event.type === "mcp_exec") {
    if (!advertised.has(event.name)) {
      return;
    }
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(event.argumentsJson) as Record<string, unknown>;
    } catch {
      args = {};
    }
    mcpCalls.push({
      id: event.toolCallId ?? `mcp-${event.id}`,
      name: event.name,
      arguments: args,
    });
  }
}

function appendText(output: PiAssistantMessage, stream: AssistantMessageEventStream, delta: string): void {
  let index = output.content.findLastIndex((block) => block.type === "text");
  if (index < 0) {
    output.content.push({ type: "text", text: "" });
    index = output.content.length - 1;
    stream.push({ type: "text_start", contentIndex: index, partial: output });
  }
  const block = output.content[index];
  if (block?.type !== "text") {
    return;
  }
  block.text += delta;
  stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
}

function appendThinking(output: PiAssistantMessage, stream: AssistantMessageEventStream, delta: string): void {
  let index = output.content.findLastIndex((block) => block.type === "thinking");
  if (index < 0) {
    output.content.push({ type: "thinking", thinking: "" });
    index = output.content.length - 1;
    stream.push({ type: "thinking_start", contentIndex: index, partial: output });
  }
  const block = output.content[index];
  if (block?.type !== "thinking") {
    return;
  }
  block.thinking += delta;
  stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: output });
}

function finishToolUse(
  stream: AssistantMessageEventStream,
  output: PiAssistantMessage,
  mcpCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
): void {
  for (const call of mcpCalls) {
    const toolCall: PiToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
    output.content.push(toolCall);
    const index = output.content.length - 1;
    const delta = JSON.stringify(call.arguments);
    stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
    stream.push({ type: "toolcall_delta", contentIndex: index, delta, partial: output });
    stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
  }
  output.stopReason = "toolUse";
  stream.push({ type: "done", reason: "toolUse", message: output });
  stream.end();
}

function fail(
  stream: AssistantMessageEventStream,
  output: PiAssistantMessage,
  options: SimpleStreamOptions | undefined,
  error: unknown,
): void {
  output.stopReason = options?.signal?.aborted || error instanceof CancelledError ? "aborted" : "error";
  output.errorMessage = redactSecrets(messageOf(error));
  stream.push({ type: "error", reason: output.stopReason, error: output });
  stream.end();
}

function messageOf(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof TransportUnsupportedError) {
    return error.message;
  }
  if (error instanceof StreamError || error instanceof AuthenticationError || error instanceof Error) {
    return error.message;
  }
  return "unknown error";
}

function latestUserText(context: PiContext): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role === "user") {
      return userText(message);
    }
  }
  return "";
}

function userText(message: Extract<PiMessage, { role: "user" }>): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  return message.content
    .filter((block): block is PiText => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function historyTurns(messages: PiMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  for (const message of messages) {
    if (message === lastUser) {
      continue;
    }
    if (message.role === "user") {
      turns.push({ role: "user", text: userText(message) });
      continue;
    }
    if (message.role === "toolResult") {
      const text = message.content
        .filter((block): block is PiText => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      turns.push({
        role: "tool",
        toolCallId: message.toolCallId,
        name: message.toolName ?? "",
        text,
        isError: message.isError,
      });
      continue;
    }
    const text = message.content
      .filter((block): block is PiText => block.type === "text")
      .map((block) => block.text)
      .join("");
    const thinking = message.content
      .filter((block): block is PiThinking => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");
    const toolCalls = message.content
      .filter((block): block is PiToolCall => block.type === "toolCall")
      .map((block) => ({
        id: block.id,
        name: block.name,
        argumentsJson: JSON.stringify(block.arguments),
      }));
    turns.push({
      role: "assistant",
      text: text.length > 0 ? text : undefined,
      thinking: thinking.length > 0 ? thinking : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
  return turns;
}
