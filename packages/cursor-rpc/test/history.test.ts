import { describe, expect, it } from "vitest";
import { conversationHistoryFromTurns } from "../src/run/history.ts";

describe("conversationHistoryFromTurns", () => {
  it("maps user, assistant, and tool turns without checkpoint blobs", () => {
    const history = conversationHistoryFromTurns([
      { role: "user", text: "hello" },
      {
        role: "assistant",
        text: "working",
        thinking: "plan",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"a.ts\"}" }],
      },
      { role: "tool", toolCallId: "call-1", name: "read_file", text: "file body" },
    ]);
    expect(history.messages).toHaveLength(3);
    expect(history.messages[0]?.message.case).toBe("user");
    expect(history.messages[1]?.message.case).toBe("assistant");
    expect(history.messages[2]?.message.case).toBe("tool");
    expect(JSON.stringify(history)).not.toContain("checkpoint");
  });
});
