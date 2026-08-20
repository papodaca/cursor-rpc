import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { CURSOR_API } from "./constants.js";
import type { AssistantMessageEventStream, PiAssistantMessage, PiModel, StreamFn } from "./types.js";

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

export function stubStream(model: PiModel): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream() as AssistantMessageEventStream;
  const output = emptyAssistant(model);
  output.stopReason = "error";
  output.errorMessage = "cursor-rpc stream is not wired";
  queueMicrotask(() => {
    stream.push({ type: "start", partial: output });
    stream.push({ type: "error", reason: "error", error: output });
    stream.end();
  });
  return stream;
}

export function cursorApiStreams(streamSimple: StreamFn): Record<
  string,
  { stream: StreamFn; streamSimple: StreamFn }
> {
  return {
    [CURSOR_API]: { stream: streamSimple, streamSimple },
  };
}
