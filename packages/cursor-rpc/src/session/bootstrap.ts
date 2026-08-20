import { PrivacyMode, type GetUserPrivacyModeResponse } from "../generated/aiserver/v1/dashboard_pb.js";
import type { GetServerConfigResponse } from "../generated/aiserver/v1/server_config_pb.js";
import type { AvailableModelsResponse, GetDefaultModelForCliResponse, GetUsableModelsResponse } from "../generated/aiserver/v1/models_pb.js";
import { http2Decision, privacyProbeUrl, selectAgentBaseUrl, type Http2Decision } from "./host.js";
import { mergeModelCatalogue, withTimeout, type ModelCatalogue } from "./models.js";

export type BootstrapClients = {
  getServerConfig: () => Promise<GetServerConfigResponse>;
  getUserPrivacyMode: (baseUrl: string) => Promise<GetUserPrivacyModeResponse>;
  getUsableModels: () => Promise<GetUsableModelsResponse>;
  getDefaultModelForCli: () => Promise<GetDefaultModelForCliResponse>;
  availableModels: (signal?: AbortSignal) => Promise<AvailableModelsResponse>;
};

export type BootstrapSession = {
  apiUrl: string;
  agentBaseUrl: string;
  ghostMode: boolean;
  http2: Http2Decision;
  models: ModelCatalogue;
  getAccessToken: () => Promise<string>;
};

export async function bootstrap(options: {
  apiUrl: string;
  getAccessToken: () => Promise<string>;
  clients: BootstrapClients;
  availableModelsTimeoutMs?: number;
}): Promise<BootstrapSession> {
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const config = await options.clients.getServerConfig();
  const http2 = http2Decision(config.http2Config);
  const ghostMode = await resolveGhostMode(options.clients, apiUrl);
  const agentBaseUrl = selectAgentBaseUrl(
    apiUrl,
    ghostMode,
    config.agentUrlConfig,
    http2.usingHttp1,
  );

  const usablePromise = catchAsError(options.clients.getUsableModels());
  const defaultPromise = catchAsError(options.clients.getDefaultModelForCli());
  const paramsPromise = catchAsError(
    withTimeout((signal) => options.clients.availableModels(signal), options.availableModelsTimeoutMs ?? 2000),
  );

  const [usable, defaultModel, parameterized] = await Promise.all([usablePromise, defaultPromise, paramsPromise]);
  const models = mergeModelCatalogue(
    usable,
    defaultModel,
    parameterized === "timed_out"
      ? "timed_out"
      : parameterized instanceof Error
        ? parameterized
        : parameterized.models,
  );

  return {
    apiUrl,
    agentBaseUrl,
    ghostMode,
    http2,
    models,
    getAccessToken: options.getAccessToken,
  };
}

export async function resolveGhostMode(clients: Pick<BootstrapClients, "getUserPrivacyMode">, apiUrl: string): Promise<boolean> {
  try {
    const privacy = await clients.getUserPrivacyMode(privacyProbeUrl(apiUrl));
    return privacy.privacyMode === PrivacyMode.UNSPECIFIED
      || privacy.privacyMode === PrivacyMode.NO_STORAGE
      || privacy.privacyMode === PrivacyMode.NO_TRAINING;
  } catch {
    return true;
  }
}

function catchAsError<T>(promise: Promise<T>): Promise<T | Error> {
  return promise.then((value) => value, (error: unknown) => error as Error);
}
