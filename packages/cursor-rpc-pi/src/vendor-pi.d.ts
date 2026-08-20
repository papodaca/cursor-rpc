declare module "@earendil-works/pi-ai" {
  export function createProvider(input: unknown): unknown;
  export function createAssistantMessageEventStream(): {
    push(event: unknown): void;
    end(result?: unknown): void;
    [Symbol.asyncIterator](): AsyncIterator<unknown>;
  };
}

declare module "@earendil-works/pi-coding-agent" {
  export type ExtensionAPI = {
    registerProvider(provider: unknown): void;
    on(event: "message_end", handler: (...args: never[]) => unknown): void;
  };
}
