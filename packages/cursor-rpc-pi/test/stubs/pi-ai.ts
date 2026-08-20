import type { AssistantMessageEvent, AssistantMessageEventStream, PiAssistantMessage } from "../../src/types.ts";

export type TestStream = AssistantMessageEventStream & {
  events: AssistantMessageEvent[];
  done: Promise<void>;
};

export function createProvider(input: unknown): unknown {
  return input;
}

export function createAssistantMessageEventStream(): TestStream {
  const events: AssistantMessageEvent[] = [];
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    events,
    done,
    push(event) {
      events.push(event);
    },
    end(_result?: PiAssistantMessage) {
      resolveDone?.();
    },
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}
