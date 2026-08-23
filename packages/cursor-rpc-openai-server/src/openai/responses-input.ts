import { conversationHistoryFromTurns, type HistoryTurn } from "cursor-rpc";
import { HttpError, invalidRequestError, isRecord } from "../errors.js";
import type { ResponseTranscript } from "./response-store.js";

export type MappedResponsesInput = {
  prompt: string;
  conversationHistory: ReturnType<typeof conversationHistoryFromTurns>;
  userText: string;
};

const ROLES = new Set(["system", "developer", "user", "assistant"]);
const TEXT_PART_TYPES = new Set(["input_text", "text"]);

export function rejectUnsupportedInputItems(input: unknown): void {
  if (!Array.isArray(input)) {
    return;
  }
  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type !== undefined && item.type !== "message") {
      throw unsupportedInput("Function calling and hosted tools are not supported");
    }
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isRecord(part) && (typeof part.type !== "string" || !TEXT_PART_TYPES.has(part.type))) {
          throw unsupportedInput("Only text content is supported");
        }
      }
    }
  }
}

export function mapResponsesInput(options: {
  input: unknown;
  instructions?: string;
  ancestorTranscripts?: readonly ResponseTranscript[];
}): MappedResponsesInput {
  const systemParts: string[] = [];
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const item of parseInputItems(options.input)) {
    if (item.role === "system" || item.role === "developer") {
      if (item.text.length > 0) {
        systemParts.push(item.text);
      }
      continue;
    }
    turns.push({ role: item.role, text: item.text });
  }
  const lastUserIndex = turns.findLastIndex((turn) => turn.role === "user");
  if (lastUserIndex === -1) {
    throw invalidInput("at least one user message is required");
  }
  if (lastUserIndex !== turns.length - 1) {
    throw invalidInput("last message must be a user message");
  }
  const lastUser = turns[lastUserIndex];
  if (lastUser === undefined || lastUser.text.length === 0) {
    throw invalidInput("at least one user message is required");
  }
  const prefixes: string[] = [];
  if (options.instructions !== undefined && options.instructions.length > 0) {
    prefixes.push(options.instructions);
  }
  prefixes.push(...systemParts);
  const prefix = prefixes.join("\n\n");
  const prompt = prefix.length > 0 ? `${prefix}\n\n${lastUser.text}` : lastUser.text;
  const historyTurns: HistoryTurn[] = [
    ...ancestorTurns(options.ancestorTranscripts ?? []),
    ...turns.slice(0, lastUserIndex),
  ];
  return {
    prompt,
    conversationHistory: conversationHistoryFromTurns(historyTurns),
    userText: lastUser.text,
  };
}

function parseInputItems(input: unknown): Array<{ role: "system" | "developer" | "user" | "assistant"; text: string }> {
  if (typeof input === "string") {
    return [{ role: "user", text: input }];
  }
  if (!Array.isArray(input)) {
    throw invalidInput("input must be a string or an array of items");
  }
  return input.map(parseItem);
}

function parseItem(item: unknown): { role: "system" | "developer" | "user" | "assistant"; text: string } {
  if (!isRecord(item)) {
    throw invalidInput("invalid input item");
  }
  if (item.type !== undefined && item.type !== "message") {
    throw unsupportedInput("Function calling and hosted tools are not supported");
  }
  const role = item.role;
  if (typeof role !== "string" || !ROLES.has(role)) {
    throw invalidInput("unsupported input role");
  }
  return {
    role: role as "system" | "developer" | "user" | "assistant",
    text: flattenContent(item.content),
  };
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    throw invalidInput("input content must be a string or text parts");
  }
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      throw invalidInput("invalid content part");
    }
    if (typeof part.type !== "string" || !TEXT_PART_TYPES.has(part.type)) {
      throw unsupportedInput("Only text content is supported");
    }
    if (typeof part.text !== "string") {
      throw invalidInput("text part is missing text");
    }
    parts.push(part.text);
  }
  return parts.join("");
}

function ancestorTurns(transcripts: readonly ResponseTranscript[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const transcript of transcripts) {
    turns.push({ role: "user", text: transcript.user });
    turns.push({ role: "assistant", text: transcript.assistant });
  }
  return turns;
}

function invalidInput(message: string): HttpError {
  return invalidRequestError("input", message);
}

const unsupportedInput = invalidInput;
