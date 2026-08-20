import { create } from "@bufbuild/protobuf";
import {
  ConversationHistoryAssistantContentSchema,
  ConversationHistoryAssistantMessageSchema,
  ConversationHistoryMessageSchema,
  ConversationHistoryReasoningContentSchema,
  ConversationHistorySchema,
  ConversationHistoryTextContentSchema,
  ConversationHistoryToolCallSchema,
  ConversationHistoryToolMessageSchema,
  ConversationHistoryToolResultContentSchema,
  ConversationHistoryUserContentSchema,
  ConversationHistoryUserMessageSchema,
  type ConversationHistory,
  type ConversationHistoryAssistantContent,
} from "../generated/agent/v1/agent_pb.js";

export type HistoryTurn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text?: string;
      thinking?: string;
      toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
    }
  | { role: "tool"; toolCallId: string; name: string; text: string; isError?: boolean };

export function conversationHistoryFromTurns(turns: HistoryTurn[]): ConversationHistory {
  const messages = turns.map((turn) => {
    if (turn.role === "user") {
      return create(ConversationHistoryMessageSchema, {
        message: {
          case: "user",
          value: create(ConversationHistoryUserMessageSchema, {
            content: [
              create(ConversationHistoryUserContentSchema, {
                content: { case: "text", value: create(ConversationHistoryTextContentSchema, { text: turn.text }) },
              }),
            ],
          }),
        },
      });
    }
    if (turn.role === "tool") {
      return create(ConversationHistoryMessageSchema, {
        message: {
          case: "tool",
          value: create(ConversationHistoryToolMessageSchema, {
            toolCallId: turn.toolCallId,
            toolName: turn.name,
            isError: turn.isError,
            content: [
              create(ConversationHistoryToolResultContentSchema, {
                content: { case: "text", value: create(ConversationHistoryTextContentSchema, { text: turn.text }) },
              }),
            ],
          }),
        },
      });
    }
    const content: ConversationHistoryAssistantContent[] = [];
    if (turn.thinking !== undefined && turn.thinking.length > 0) {
      content.push(
        create(ConversationHistoryAssistantContentSchema, {
          content: {
            case: "reasoning",
            value: create(ConversationHistoryReasoningContentSchema, { text: turn.thinking }),
          },
        }),
      );
    }
    if (turn.text !== undefined && turn.text.length > 0) {
      content.push(
        create(ConversationHistoryAssistantContentSchema, {
          content: { case: "text", value: create(ConversationHistoryTextContentSchema, { text: turn.text }) },
        }),
      );
    }
    for (const call of turn.toolCalls ?? []) {
      content.push(
        create(ConversationHistoryAssistantContentSchema, {
          content: {
            case: "toolCall",
            value: create(ConversationHistoryToolCallSchema, {
              toolCallId: call.id,
              toolName: call.name,
              argsJson: call.argumentsJson,
            }),
          },
        }),
      );
    }
    return create(ConversationHistoryMessageSchema, {
      message: {
        case: "assistant",
        value: create(ConversationHistoryAssistantMessageSchema, { content }),
      },
    });
  });
  return create(ConversationHistorySchema, { messages });
}
