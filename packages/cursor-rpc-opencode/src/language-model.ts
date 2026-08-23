import { UnsupportedFunctionalityError, type LanguageModelV3, type LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { CursorRpcClient } from "cursor-rpc";

export class CursorLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};
  readonly #getClient: () => CursorRpcClient;

  constructor(options: { provider: string; modelId: string; getClient: () => CursorRpcClient }) {
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.#getClient = options.getClient;
  }

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<never> {
    this.#getClient();
    throw new UnsupportedFunctionalityError({
      functionality: "doGenerate",
      message: "doGenerate is not implemented",
    });
  }

  async doStream(_options: LanguageModelV3CallOptions): Promise<never> {
    this.#getClient();
    throw new UnsupportedFunctionalityError({
      functionality: "doStream",
      message: "doStream is not implemented",
    });
  }
}
