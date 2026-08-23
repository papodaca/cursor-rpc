import type { LanguageModelV3CallOptions, LanguageModelV3Message } from "@ai-sdk/provider";
import type { ClientRunOptions, ConversationHistory, CursorRpcClient, RunEvent, RunHandle } from "cursor-rpc";
import { describe, expect, it } from "vitest";
import { CursorLanguageModel } from "../src/language-model.ts";

function system(content: string): LanguageModelV3Message {
  return { role: "system", content };
}

function user(text: string): LanguageModelV3Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): LanguageModelV3Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function historyRole(message: ConversationHistory["messages"][number]): string | undefined {
  return message.message.case;
}

function historyText(message: ConversationHistory["messages"][number] | undefined): string {
  if (message?.message.case === "user" || message?.message.case === "assistant") {
    return message.message.value.content
      .map((part) => (part.content.case === "text" ? part.content.value.text : ""))
      .join("");
  }
  return "";
}

function completedHandle(): RunHandle {
  const events: RunEvent[] = [
    { type: "text_delta", text: "ok" },
    { type: "turn_ended", usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    wait: async () => ({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, events }),
    abort: () => undefined,
    conversationHistory: () => createConversationHistory(),
  };
}

function createConversationHistory(messages: ConversationHistory["messages"] = []): ConversationHistory {
  return { messages } as ConversationHistory;
}

async function captureRun(prompt: LanguageModelV3CallOptions["prompt"], extra: Partial<LanguageModelV3CallOptions> = {}) {
  let captured: ClientRunOptions | undefined;
  const close = (): void => undefined;
  const client = {
    close,
    run: async (options: ClientRunOptions): Promise<RunHandle> => {
      captured = options;
      return completedHandle();
    },
  } as CursorRpcClient;
  const model = new CursorLanguageModel({
    provider: "cursor-rpc",
    modelId: "composer",
    getClient: () => client,
  });
  await model.doStream({ prompt, ...extra });
  if (captured === undefined) {
    throw new Error("client.run was not called");
  }
  return captured;
}

describe("prompt mapping", () => {
  it("folds system text into the last user prompt and omits customSystemPrompt", async () => {
    const captured = await captureRun([system("Be terse."), user("Hello")]);

    expect(captured.prompt).toBe("Be terse.\n\nHello");
    expect(captured.customSystemPrompt).toBeUndefined();
    expect(captured.modelId).toBe("composer");
    expect(captured.mode === "ask" || captured.mode === undefined).toBe(true);
    expect(captured.mcpTools).toBeUndefined();
    expect(captured.handlers).toBeUndefined();
    expect(captured.conversationHistory === undefined || captured.conversationHistory.messages.length === 0).toBe(
      true,
    );
  });

  it("maps user/assistant/user so the last user is prompt and the first pair is history", async () => {
    const captured = await captureRun([user("What is 2+2?"), assistant("4"), user("And 3+3?")]);

    expect(captured.prompt).toBe("And 3+3?");
    expect(captured.customSystemPrompt === undefined || captured.customSystemPrompt === "").toBe(true);
    const messages = captured.conversationHistory?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(historyRole(messages[0]!)).toBe("user");
    expect(historyText(messages[0])).toBe("What is 2+2?");
    expect(historyRole(messages[1]!)).toBe("assistant");
    expect(historyText(messages[1])).toBe("4");
  });

  it("forwards abortSignal and does not set exec handlers", async () => {
    const abortSignal = new AbortController().signal;
    const captured = await captureRun([user("hi")], {
      abortSignal,
      temperature: 0.2,
      topP: 0.9,
      tools: [{ type: "function", name: "lookup", inputSchema: { type: "object" } }],
    });

    expect(captured.signal).toBe(abortSignal);
    expect(captured.mcpTools?.[0]?.name).toBe("lookup");
    expect(captured.mcpTools?.[0]?.toolName).toBe("lookup");
    expect(captured.handlers).toBeUndefined();
    expect(captured.handlers?.onExec).toBeUndefined();
    expect(captured.handlers?.onInteraction).toBeUndefined();
  });

  it("skips file parts and maps tool-call / tool-result into history", async () => {
    const captured = await captureRun([
      user("see this"),
      {
        role: "user",
        content: [
          { type: "text", text: "caption" },
          { type: "file", data: "abc", mediaType: "image/png", filename: "x.png" },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: {} }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "lookup", output: { type: "text", value: "n/a" } }],
      },
      user("continue"),
    ]);

    expect(captured.prompt).toBe("continue");
    expect(captured.conversationHistory?.messages.some((message) => message.message.case === "tool")).toBe(true);
    const historyJson = JSON.stringify(captured.conversationHistory);
    expect(historyJson).not.toMatch(/image\/png|x\.png/);
  });
});
