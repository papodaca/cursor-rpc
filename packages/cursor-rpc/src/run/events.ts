export type UsageCounts = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};

export type RunEvent =
  | { type: "text_delta"; text: string }
  | { type: "server_notice"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_completed"; durationMs: number }
  | { type: "token_delta"; tokens: number }
  | { type: "heartbeat" }
  | { type: "turn_ended"; usage: UsageCounts }
  | { type: "tool_call"; callId: string; toolCallId?: string; phase: "started" | "completed" | "partial" }
  | { type: "prompt_suggestion"; suggestion: string }
  | { type: "routed_model"; displayName: string }
  | { type: "checkpoint" }
  | { type: "connection"; state: "connected" | "failed" };

export type RunResult = {
  text: string;
  usage: UsageCounts;
  events: RunEvent[];
};
