import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AgentServerMessageSchema } from "../src/generated/agent/v1/agent_pb.ts";
import { buildConversationHistory } from "../src/run/transcript.ts";

describe("conversation history", () => {
  it("serializes user/assistant text and omits conversationState blobs", () => {
    const history = buildConversationHistory("hello", [
      { type: "text_delta", text: "world" },
      { type: "checkpoint" },
    ]);
    expect(history.messages).toHaveLength(2);
    expect(JSON.stringify(history)).toContain("hello");
    expect(JSON.stringify(history)).toContain("world");
    expect(JSON.stringify(history)).not.toMatch(/conversationState|blobId/i);
    const inbound = create(AgentServerMessageSchema, {
      message: {
        case: "conversationCheckpointUpdate",
        value: { rootPromptMessagesJson: [new Uint8Array([1, 2, 3])] },
      },
    });
    expect(inbound.message.case).toBe("conversationCheckpointUpdate");
  });
});
