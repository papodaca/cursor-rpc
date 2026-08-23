import type { LanguageModelV3Message, LanguageModelV3Prompt, SharedV3Warning } from "@ai-sdk/provider";
import type { ConversationHistory } from "cursor-rpc";

export type MappedPrompt = {
  prompt: string;
  customSystemPrompt?: string;
  conversationHistory?: ConversationHistory;
  warnings: SharedV3Warning[];
};

type HistoryTurn = {
  role: "user" | "assistant";
  text: string;
};

export function mapPrompt(messages: LanguageModelV3Prompt): MappedPrompt {
  const warnings: SharedV3Warning[] = [];
  const systems: string[] = [];
  const turns: HistoryTurn[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.length > 0) {
        systems.push(message.content);
      }
      continue;
    }
    if (message.role === "tool") {
      warnings.push(skipped("tool-result", "tool results are skipped until later work"));
      continue;
    }
    if (message.role === "user") {
      turns.push({ role: "user", text: collectUserText(message, warnings) });
      continue;
    }
    turns.push({ role: "assistant", text: collectAssistantText(message, warnings) });
  }

  let lastUserIndex = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  const prompt = lastUserIndex >= 0 ? (turns[lastUserIndex]?.text ?? "") : "";
  const prior = lastUserIndex >= 0 ? turns.slice(0, lastUserIndex) : turns;
  const historyTurns = prior.filter((turn) => turn.text.length > 0);
  const customSystemPrompt = systems.length > 0 ? systems.join("\n\n") : undefined;

  return {
    prompt,
    warnings,
    ...(customSystemPrompt === undefined ? {} : { customSystemPrompt }),
    ...(historyTurns.length === 0 ? {} : { conversationHistory: buildHistory(historyTurns) }),
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

function collectAssistantText(
  message: Extract<LanguageModelV3Message, { role: "assistant" }>,
  warnings: SharedV3Warning[],
): string {
  const texts: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      texts.push(part.text);
      continue;
    }
    if (part.type === "reasoning") {
      continue;
    }
    if (part.type === "tool-call" || part.type === "tool-result") {
      warnings.push(skipped(part.type, "tool parts are skipped until later work"));
      continue;
    }
    warnings.push(skipped("file", "file and image parts are skipped"));
  }
  return texts.join("");
}

function buildHistory(turns: HistoryTurn[]): ConversationHistory {
  return {
    messages: turns.map((turn) =>
      turn.role === "user"
        ? {
            message: {
              case: "user" as const,
              value: {
                content: [
                  {
                    content: {
                      case: "text" as const,
                      value: { text: turn.text },
                    },
                  },
                ],
              },
            },
          }
        : {
            message: {
              case: "assistant" as const,
              value: {
                content: [
                  {
                    content: {
                      case: "text" as const,
                      value: { text: turn.text },
                    },
                  },
                ],
              },
            },
          },
    ),
  } as ConversationHistory;
}

function skipped(feature: string, details: string): SharedV3Warning {
  return { type: "unsupported", feature, details };
}
