import { ClientEpoch, clientForStream, cursorAuth } from "./auth.js";
import { fetchCursorModels } from "./models.js";
import { streamCursor } from "./stream.js";
import { cursorApiStreams, stubStream } from "./stream-stub.js";
import { CURSOR_API, PROVIDER_ID } from "./constants.js";
import type { CreateProviderInput, FetchModelsContext, PiModel, StreamFn } from "./types.js";

const epoch = new ClientEpoch();

export function cursorProviderInput(options: {
  auth?: unknown;
  fetchModels?: (context: FetchModelsContext) => Promise<PiModel[]>;
  streamSimple?: StreamFn;
  epoch?: ClientEpoch;
} = {}): CreateProviderInput {
  const activeEpoch = options.epoch ?? epoch;
  const streamSimple =
    options.streamSimple ?? ((model, context, streamOptions) => streamCursor(activeEpoch, model, context, streamOptions));
  return {
    id: PROVIDER_ID,
    name: "Cursor RPC",
    models: [],
    fetchModels:
      options.fetchModels ??
      (async (context) => {
        const apiKey =
          context.credential !== undefined && "access" in context.credential
            ? context.credential.access
            : context.credential !== undefined && "key" in context.credential
              ? context.credential.key
              : undefined;
        const client = clientForStream(activeEpoch, { apiKey, signal: context.signal });
        if (client === undefined) {
          return [];
        }
        try {
          return await fetchCursorModels((signal) => client.models(signal), context.signal);
        } catch {
          return [];
        }
      }),
    auth: options.auth ?? cursorAuth(),
    api: cursorApiStreams(streamSimple),
  };
}

export function withCursorApi(model: Omit<PiModel, "provider" | "api">): PiModel {
  return {
    ...model,
    provider: PROVIDER_ID,
    api: CURSOR_API,
  };
}

export { stubStream };
