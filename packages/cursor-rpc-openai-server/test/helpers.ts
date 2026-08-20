import { AuthenticationError, conversationHistoryFromTurns, type ClientRunOptions, type RunEvent, type RunHandle } from "cursor-rpc";
import { startServer } from "../src/server.ts";
import type { ServerProvider } from "../src/provider.ts";

export const INBOUND_KEY = "sk-inbound-secret";

export function fakeHandle(events: RunEvent[], onAbort?: () => void): RunHandle {
  const text = events.filter((event) => event.type === "text_delta").map((event) => event.text).join("");
  const ended = events.find((event) => event.type === "turn_ended");
  const usage = ended?.type === "turn_ended" ? ended.usage : {};
  return {
    abort: () => {
      onAbort?.();
    },
    wait: async () => ({ text, usage, events }),
    conversationHistory: () => conversationHistoryFromTurns([]),
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

export function fakeProvider(options: {
  ids?: string[];
  run?: ServerProvider["run"];
  events?: RunEvent[];
  onRun?: (options: ClientRunOptions) => void;
} = {}): ServerProvider {
  const ids = options.ids ?? ["composer-2"];
  return {
    async models() {
      return {
        ids,
        defaultId: ids[0],
        resolve(id: string) {
          const match = ids.find((canonical) => canonical.toLowerCase() === id.toLowerCase());
          return match;
        },
      };
    },
    run: async (runOptions) => {
      options.onRun?.(runOptions);
      if (options.run !== undefined) {
        return options.run(runOptions);
      }
      return fakeHandle(
        options.events ?? [
          { type: "thinking_delta", text: "hidden" },
          { type: "text_delta", text: "hi" },
          { type: "turn_ended", usage: { inputTokens: 3, outputTokens: 1 } },
        ],
      );
    },
  };
}

export async function startTestServer(provider: ServerProvider = fakeProvider()) {
  return startServer({
    env: {
      CURSOR_RPC_OPENAI_API_KEY: INBOUND_KEY,
      CURSOR_RPC_OPENAI_HOST: "127.0.0.1",
      CURSOR_RPC_OPENAI_PORT: "0",
    },
    provider,
  });
}

export function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${INBOUND_KEY}`, ...extra };
}

export async function createCompletion(url: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body),
    ...init,
  });
}

export function thinkingThenHi(): RunEvent[] {
  return [
    { type: "thinking_delta", text: "I should greet" },
    { type: "server_notice", text: "notice" },
    { type: "text_delta", text: "hi" },
    { type: "turn_ended", usage: { inputTokens: 4, outputTokens: 1 } },
  ];
}

export { AuthenticationError };
