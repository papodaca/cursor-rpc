import { CURSOR_API } from "./constants.js";
import type { PiAssistantMessage, PiModel, StreamFn } from "./types.js";

export function emptyAssistant(model: PiModel): PiAssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

export function cursorApiStreams(streamSimple: StreamFn): Record<
  string,
  { stream: StreamFn; streamSimple: StreamFn }
> {
  return {
    [CURSOR_API]: { stream: streamSimple, streamSimple },
  };
}
