import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import type { CursorRpcClient } from "cursor-rpc";
import { consumeCursorStream, streamCursorRun, toProviderError } from "./stream.js";

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

  async doGenerate(options: LanguageModelV3CallOptions) {
    const { stream } = await this.doStream(options);
    return consumeCursorStream(stream);
  }

  async doStream(options: LanguageModelV3CallOptions) {
    let client: CursorRpcClient;
    try {
      client = this.#getClient();
    } catch (error) {
      throw toProviderError(error);
    }
    return streamCursorRun({ client, modelId: this.modelId, call: options });
  }
}
