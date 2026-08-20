export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "pending";

export type PiTool = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type PiText = { type: "text"; text: string };
export type PiThinking = { type: "thinking"; thinking: string; thinkingSignature?: string };
export type PiToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
export type PiContent = PiText | PiThinking | PiToolCall;

export type PiUserMessage = { role: "user"; content: string | PiText[] };
export type PiAssistantMessage = {
  role: "assistant";
  content: PiContent[];
  api: string;
  provider: string;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason: StopReason;
  timestamp: number;
  errorMessage?: string;
};
export type PiToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: PiText[];
  isError?: boolean;
};
export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export type PiModel = {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

export type PiContext = {
  systemPrompt?: string;
  messages: PiMessage[];
  tools?: PiTool[];
};

export type SimpleStreamOptions = {
  apiKey?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  reasoning?: string;
};

export type AssistantMessageEvent =
  | { type: "start"; partial: PiAssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: PiAssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: PiAssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: PiAssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: PiAssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: PiToolCall; partial: PiAssistantMessage }
  | { type: "done"; reason: StopReason; message: PiAssistantMessage }
  | { type: "error"; reason: StopReason; error: PiAssistantMessage };

export type AssistantMessageEventStream = {
  push(event: AssistantMessageEvent): void;
  end(result?: PiAssistantMessage): void;
};

export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number;
};

export type OAuthLoginCallbacks = {
  onAuth(params: { url: string }): void;
  onPrompt?(params: { message: string }): Promise<string>;
};

export type ApiKeyCredential = { type: "api_key"; key?: string };
export type OAuthCredential = { type: "oauth" } & OAuthCredentials;
export type StoredCredential = ApiKeyCredential | OAuthCredential | undefined;

export type FetchModelsContext = {
  credential?: StoredCredential;
  signal?: AbortSignal;
  allowNetwork?: boolean;
};

export type CreateProviderInput = {
  id: string;
  name?: string;
  models: PiModel[];
  fetchModels?: (context: FetchModelsContext) => Promise<PiModel[]>;
  auth?: unknown;
  api: Record<string, { stream: StreamFn; streamSimple: StreamFn }>;
};

export type StreamFn = (
  model: PiModel,
  context: PiContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export type CreateProvider = (input: CreateProviderInput) => unknown;
export type CreateStream = () => AssistantMessageEventStream;

export type ExtensionAPI = {
  registerProvider(provider: unknown): void;
  on(
    event: "message_end",
    handler: (
      event: { message: PiAssistantMessage | PiMessage },
      ctx: { model?: PiModel },
    ) => { message: PiAssistantMessage } | void,
  ): void;
};
