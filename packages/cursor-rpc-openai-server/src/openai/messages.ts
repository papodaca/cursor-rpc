import { conversationHistoryFromTurns, type HistoryTurn } from "cursor-rpc";
import { HttpError, openaiError } from "../errors.js";

export type MappedMessages = {
  prompt: string;
  conversationHistory: ReturnType<typeof conversationHistoryFromTurns>;
};

const ROLES = new Set(["system", "developer", "user", "assistant"]);

export function mapMessages(messages: unknown): MappedMessages {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw invalidMessages("messages is required");
  }
  const systemParts: string[] = [];
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object") {
      throw invalidMessages("invalid message");
    }
    const role = (message as { role?: unknown }).role;
    if (typeof role !== "string" || !ROLES.has(role)) {
      throw invalidMessages("unsupported message role");
    }
    const text = flattenContent((message as { content?: unknown }).content);
    if (role === "system" || role === "developer") {
      if (text.length > 0) {
        systemParts.push(text);
      }
      continue;
    }
    turns.push({ role: role === "user" ? "user" : "assistant", text });
  }
  const lastUserIndex = turns.findLastIndex((turn) => turn.role === "user");
  if (lastUserIndex === -1) {
    throw invalidMessages("at least one user message is required");
  }
  if (lastUserIndex !== turns.length - 1) {
    throw invalidMessages("last message must be a user message");
  }
  const lastUser = turns[lastUserIndex];
  if (lastUser === undefined) {
    throw invalidMessages("at least one user message is required");
  }
  const historyTurns: HistoryTurn[] = turns.slice(0, lastUserIndex);
  const system = systemParts.join("\n\n");
  const prompt = system.length > 0 ? `${system}\n\n${lastUser.text}` : lastUser.text;
  return {
    prompt,
    conversationHistory: conversationHistoryFromTurns(historyTurns),
  };
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    throw invalidMessages("message content must be a string or text parts");
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") {
      throw invalidMessages("invalid content part");
    }
    const type = (part as { type?: unknown }).type;
    if (type !== "text") {
      throw new HttpError(
        400,
        openaiError({
          message: "Only text content is supported",
          type: "invalid_request_error",
          param: "messages",
          code: "unsupported_content",
        }),
      );
    }
    const text = (part as { text?: unknown }).text;
    if (typeof text !== "string") {
      throw invalidMessages("text part is missing text");
    }
    parts.push(text);
  }
  return parts.join("");
}

function invalidMessages(message: string): HttpError {
  return new HttpError(
    400,
    openaiError({
      message,
      type: "invalid_request_error",
      param: "messages",
      code: "invalid_request_error",
    }),
  );
}
