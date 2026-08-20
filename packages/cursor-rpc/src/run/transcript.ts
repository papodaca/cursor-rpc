import { create } from "@bufbuild/protobuf";
import {
  ConversationHistoryMessageSchema,
  ConversationHistorySchema,
  ConversationHistoryTextContentSchema,
  ConversationHistoryUserContentSchema,
  ConversationHistoryUserMessageSchema,
  ConversationHistoryAssistantContentSchema,
  ConversationHistoryAssistantMessageSchema,
  type ConversationHistory,
} from "../generated/agent/v1/agent_pb.js";
import type { RunEvent } from "./events.js";

export function textFromEvents(events: RunEvent[]): string {
  return events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.text)
    .join("");
}

export function buildConversationHistory(prompt: string, events: RunEvent[]): ConversationHistory {
  const messages = [
    create(ConversationHistoryMessageSchema, {
      message: {
        case: "user",
        value: create(ConversationHistoryUserMessageSchema, {
          content: [
            create(ConversationHistoryUserContentSchema, {
              content: {
                case: "text",
                value: create(ConversationHistoryTextContentSchema, { text: prompt }),
              },
            }),
          ],
        }),
      },
    }),
  ];
  const assistantText = textFromEvents(events);
  if (assistantText.length > 0) {
    messages.push(
      create(ConversationHistoryMessageSchema, {
        message: {
          case: "assistant",
          value: create(ConversationHistoryAssistantMessageSchema, {
            content: [
              create(ConversationHistoryAssistantContentSchema, {
                content: {
                  case: "text",
                  value: create(ConversationHistoryTextContentSchema, { text: assistantText }),
                },
              }),
            ],
          }),
        },
      }),
    );
  }
  return create(ConversationHistorySchema, { messages });
}
