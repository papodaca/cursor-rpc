import type { LanguageModelV3Message, LanguageModelV3Prompt, SharedV3Warning } from "@ai-sdk/provider";
import type { ConversationHistory } from "cursor-rpc";

export type MappedPrompt = {
  prompt: string;
  customSystemPrompt?: string;
  conversationHistory?: ConversationHistory;
  warnings: SharedV3Warning[];
};

type AssistantPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; argsJson: string };

type HistoryItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; parts: AssistantPart[] }
  | { kind: "tool"; toolCallId: string; toolName: string; text: string; isError?: boolean };

export function mapPrompt(messages: LanguageModelV3Prompt): MappedPrompt {
  const warnings: SharedV3Warning[] = [];
  const systems: string[] = [];
  const items: HistoryItem[] = [];
  let lastUserIndex = -1;

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.length > 0) {
        systems.push(message.content);
      }
      continue;
    }
    if (message.role === "user") {
      items.push({ kind: "user", text: collectUserText(message, warnings) });
      lastUserIndex = items.length - 1;
      continue;
    }
    if (message.role === "tool") {
      items.push(...collectToolResults(message, warnings));
      continue;
    }
    const parts = collectAssistantParts(message, warnings);
    if (parts.length > 0) {
      items.push({ kind: "assistant", parts });
    }
  }

  const last = lastUserIndex >= 0 ? items[lastUserIndex] : undefined;
  const prompt = last?.kind === "user" ? last.text : "";
  const historyItems = items.filter((item, index) => index !== lastUserIndex && !isEmptyHistoryItem(item));
  const customSystemPrompt = systems.length > 0 ? systems.join("\n\n") : undefined;

  return {
    prompt,
    warnings,
    ...(customSystemPrompt === undefined ? {} : { customSystemPrompt }),
    ...(historyItems.length === 0 ? {} : { conversationHistory: buildHistory(historyItems) }),
  };
}

function collectUserText(message: Extract<LanguageModelV3Message, { role: "user" }>, warnings: SharedV3Warning[]): string {
  const texts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      texts.push(part.text);
      continue;
    }
    warnings.push(skipped("file", "file and image parts are skipped"));
  }
  return texts.join("");
}

function collectAssistantParts(
  message: Extract<LanguageModelV3Message, { role: "assistant" }>,
  warnings: SharedV3Warning[],
): AssistantPart[] {
  const parts: AssistantPart[] = [];
  let pendingText = "";
  const flushText = (): void => {
    if (pendingText.length > 0) {
      parts.push({ type: "text", text: pendingText });
      pendingText = "";
    }
  };
  for (const part of message.content) {
    if (part.type === "text") {
      pendingText += part.text;
      continue;
    }
    if (part.type === "reasoning") {
      continue;
    }
    if (part.type === "tool-call") {
      flushText();
      parts.push({
        type: "tool_call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        argsJson: stringifyArgs(part.input),
      });
      continue;
    }
    if (part.type === "tool-result") {
      warnings.push(skipped(part.type, "assistant tool-result parts are skipped"));
      continue;
    }
    warnings.push(skipped("file", "file and image parts are skipped"));
  }
  flushText();
  return parts;
}

function collectToolResults(
  message: Extract<LanguageModelV3Message, { role: "tool" }>,
  warnings: SharedV3Warning[],
): Array<Extract<HistoryItem, { kind: "tool" }>> {
  const results: Array<Extract<HistoryItem, { kind: "tool" }>> = [];
  for (const part of message.content) {
    if (part.type !== "tool-result") {
      warnings.push(skipped(part.type, "non-result tool parts are skipped"));
      continue;
    }
    const output = toolOutputText(part.output);
    results.push({
      kind: "tool",
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      text: output.text,
      ...(output.isError === true ? { isError: true } : {}),
    });
  }
  return results;
}

function stringifyArgs(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input ?? {});
}

function toolOutputText(output: { type: string; value?: unknown; reason?: string }): { text: string; isError?: boolean } {
  switch (output.type) {
    case "text":
      return { text: typeof output.value === "string" ? output.value : String(output.value ?? "") };
    case "json":
      return { text: JSON.stringify(output.value) };
    case "error-text":
      return { text: typeof output.value === "string" ? output.value : String(output.value ?? ""), isError: true };
    case "error-json":
      return { text: JSON.stringify(output.value), isError: true };
    case "execution-denied":
      return { text: output.reason ?? "execution denied", isError: true };
    case "content":
      if (Array.isArray(output.value)) {
        return {
          text: output.value
            .filter((item): item is { type: "text"; text: string } => {
              return typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item;
            })
            .map((item) => item.text)
            .join(""),
        };
      }
      return { text: "" };
    default:
      return { text: output.value === undefined ? "" : stringifyArgs(output.value) };
  }
}

function isEmptyHistoryItem(item: HistoryItem): boolean {
  if (item.kind === "user") {
    return item.text.length === 0;
  }
  if (item.kind === "assistant") {
    return item.parts.length === 0;
  }
  return false;
}

function buildHistory(items: HistoryItem[]): ConversationHistory {
  return {
    messages: items.map((item) => {
      if (item.kind === "user") {
        return {
          message: {
            case: "user" as const,
            value: {
              content: [
                {
                  content: {
                    case: "text" as const,
                    value: { text: item.text },
                  },
                },
              ],
            },
          },
        };
      }
      if (item.kind === "tool") {
        return {
          message: {
            case: "tool" as const,
            value: {
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              content: [
                {
                  content: {
                    case: "text" as const,
                    value: { text: item.text },
                  },
                },
              ],
              ...(item.isError === true ? { isError: true } : {}),
            },
          },
        };
      }
      return {
        message: {
          case: "assistant" as const,
          value: {
            content: item.parts.map((part) =>
              part.type === "text"
                ? {
                    content: {
                      case: "text" as const,
                      value: { text: part.text },
                    },
                  }
                : {
                    content: {
                      case: "toolCall" as const,
                      value: {
                        toolCallId: part.toolCallId,
                        toolName: part.toolName,
                        argsJson: part.argsJson,
                      },
                    },
                  },
            ),
          },
        },
      };
    }),
  } as ConversationHistory;
}

function skipped(feature: string, details: string): SharedV3Warning {
  return { type: "unsupported", feature, details };
}
