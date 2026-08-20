export const name = "cursor-rpc";

export {
  AuthenticationError,
  CancelledError,
  CursorRpcError,
  PolicyError,
  StreamError,
  TransportUnsupportedError,
} from "./errors.js";

export {
  createClient,
  login,
  type ClientRunOptions,
  type ClientTools,
  type CreateClientOptions,
  type CursorRpcClient,
} from "./client.js";

export {
  createWebClient,
  type CreateWebClientOptions,
  type WebClient,
  type WebClientFetchOutcome,
  type WebClientSearchDocument,
  type WebClientSearchOutcome,
} from "./web/client.js";

export { createLoginChallenge, pollLogin, type LoginChallenge } from "./auth/login.js";
export type { TokenPair } from "./auth/api-key.js";
export { MemoryCredentialStore, type CredentialStore, type StoredCredentials } from "./credentials.js";
export type { RunEvent, RunResult, UsageCounts } from "./run/events.js";
export type { RunHandle } from "./run/run.js";
export type { McpToolDto, RunMode, RunRequestOptions } from "./run/run.js";
export { replyMcpResult, type DispatchHandlers } from "./run/dispatch.js";
export { conversationHistoryFromTurns, type HistoryTurn } from "./run/history.js";
export type { ModelCatalogue } from "./session/models.js";
export type { ConversationHistory, AgentClientMessage, InteractionQuery, ExecServerMessage } from "./generated/agent/v1/agent_pb.js";
export type { AvailableModel, ModelDetails } from "./generated/aiserver/v1/models_pb.js";
