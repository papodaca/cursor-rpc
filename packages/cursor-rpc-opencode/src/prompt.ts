import type {
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
  SharedV3Warning,
} from "@ai-sdk/provider";
import { conversationHistoryFromTurns, type ConversationHistory, type HistoryTurn } from "cursor-rpc";

export type MappedPrompt = {
  prompt: string;
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

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.length > 0) {
        systems.push(message.content);
      }
      continue;
    }
    if (message.role === "user") {
      items.push({ kind: "user", text: collectUserText(message, warnings) });
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

  const lastItem = items.at(-1);
  const lastIsUser = lastItem?.kind === "user";
  const userPrompt = lastIsUser ? lastItem.text : "";
  const systemBlock = systems.join("\n\n");
  const historyItems = (lastIsUser ? items.slice(0, -1) : items).filter((item) => !isEmptyHistoryItem(item));
  const prompt = lastIsUser
    ? systemBlock.length === 0
      ? userPrompt
      : userPrompt.length === 0
        ? systemBlock
        : `${systemBlock}\n\n${userPrompt}`
    : continuationPrompt(systemBlock, historyItems);

  return {
    prompt,
    warnings,
    ...(historyItems.length === 0 ? {} : { conversationHistory: conversationHistoryFromTurns(toHistoryTurns(historyItems)) }),
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

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function toolOutputText(output: LanguageModelV3ToolResultOutput): { text: string; isError?: boolean } {
  switch (output.type) {
    case "text":
      return { text: asText(output.value) };
    case "json":
      return { text: JSON.stringify(output.value) };
    case "error-text":
      return { text: asText(output.value), isError: true };
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
      return { text: "" };
  }
}

function isEmptyHistoryItem(item: HistoryItem): boolean {
  return item.kind === "user" && item.text.length === 0;
}

const CONTINUATION = "Continue from the conversation above. Do not repeat completed tool calls.";

function continuationPrompt(systemBlock: string, historyItems: HistoryItem[]): string {
  const transcript = historyItems.map(formatHistoryItem).join("\n\n");
  return [systemBlock, transcript, CONTINUATION].filter((part) => part.length > 0).join("\n\n");
}

function formatHistoryItem(item: HistoryItem): string {
  if (item.kind === "user") {
    return `User:\n${item.text}`;
  }
  if (item.kind === "tool") {
    return `Tool ${item.toolName} result:\n${item.text}`;
  }
  const lines: string[] = [];
  for (const part of item.parts) {
    if (part.type === "text") {
      lines.push(part.text);
    } else {
      lines.push(`Called ${part.toolName} with ${part.argsJson}`);
    }
  }
  return `Assistant:\n${lines.join("\n")}`;
}

function toHistoryTurns(items: HistoryItem[]): HistoryTurn[] {
  return items.map((item) => {
    if (item.kind === "user") {
      return { role: "user", text: item.text };
    }
    if (item.kind === "tool") {
      return {
        role: "tool",
        toolCallId: item.toolCallId,
        name: item.toolName,
        text: item.text,
        ...(item.isError === true ? { isError: true } : {}),
      };
    }
    return {
      role: "assistant",
      text: item.parts
        .filter((part): part is Extract<AssistantPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join(""),
      toolCalls: item.parts
        .filter((part): part is Extract<AssistantPart, { type: "tool_call" }> => part.type === "tool_call")
        .map((part) => ({ id: part.toolCallId, name: part.toolName, argumentsJson: part.argsJson })),
    };
  });
}

function skipped(feature: string, details: string): SharedV3Warning {
  return { type: "unsupported", feature, details };
}
