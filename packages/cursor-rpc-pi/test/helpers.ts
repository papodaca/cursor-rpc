import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientRunOptions, CursorRpcClient, RunEvent, RunHandle } from "cursor-rpc";
import { ClientEpoch } from "../src/auth.ts";
import { CURSOR_API, PROVIDER_ID } from "../src/constants.ts";
import type { PiModel } from "../src/types.ts";
import type { TestStream } from "./stubs/pi-ai.ts";

export const TEST_MODEL: PiModel = {
  id: "composer-2.5",
  name: "Composer",
  provider: PROVIDER_ID,
  api: CURSOR_API,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};

export type RecordedRun = {
  options: ClientRunOptions;
  replies: unknown[];
  abortCount: number;
};

export function waitForStream(stream: { done?: Promise<void> }): Promise<void> {
  return stream.done ?? Promise.resolve();
}

export function asTestStream(stream: unknown): TestStream {
  return stream as TestStream;
}

export function fakeEpoch(script: {
  events?: RunEvent[] | ((options: ClientRunOptions) => RunEvent[]);
  error?: unknown | ((options: ClientRunOptions) => unknown);
  runImpl?: (options: ClientRunOptions) => Promise<RunHandle>;
  created?: CursorRpcClient[];
}): { epoch: ClientEpoch; runs: RecordedRun[]; clients: CursorRpcClient[] } {
  const runs: RecordedRun[] = [];
  const clients: CursorRpcClient[] = script.created ?? [];
  const epoch = new ClientEpoch((secret) => {
    const client: CursorRpcClient = {
      models: async () => ({ models: [], aliasMap: new Map() }),
      run: async (options) => {
        if (script.runImpl !== undefined) {
          return script.runImpl(options);
        }
        const recorded: RecordedRun = { options, replies: [], abortCount: 0 };
        runs.push(recorded);
        const events = typeof script.events === "function" ? script.events(options) : (script.events ?? []);
        const error = typeof script.error === "function" ? script.error(options) : script.error;
        const handle: RunHandle = {
          async *[Symbol.asyncIterator]() {
            for (const event of events) {
              if (event.type === "mcp_exec") {
                const reply = await options.handlers?.onExec?.({
                  id: event.id,
                  execId: event.execId,
                  message: { case: "mcpArgs" },
                } as never);
                recorded.replies.push(reply);
              }
              yield event;
            }
            if (error !== undefined) {
              throw error;
            }
          },
          wait: async () => {
            if (error !== undefined) {
              throw error;
            }
            return { text: "", usage: {}, events };
          },
          abort: () => {
            recorded.abortCount += 1;
          },
          conversationHistory: () => ({ messages: [] }) as never,
        };
        return handle;
      },
      close: () => undefined,
    };
    void secret;
    clients.push(client);
    return client;
  });
  return { epoch, runs, clients };
}

export function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cursor-rpc-pi-"));
  mkdirSync(join(home, ".cursor"), { recursive: true });
  writeFileSync(join(home, ".cursor", "auth.json"), JSON.stringify({ accessToken: "harvest-me" }));
  return home;
}
