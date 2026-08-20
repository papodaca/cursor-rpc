import { ClientEpoch, clientForStream, cursorAuth, isOauthCredential } from "./auth.js";
import { fetchCursorModels } from "./models.js";
import { streamCursor } from "./stream.js";
import { cursorApiStreams } from "./stream-stub.js";
import { PROVIDER_ID } from "./constants.js";
import type { CreateProviderInput, FetchModelsContext, PiModel, StoredCredential, StreamFn } from "./types.js";

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
        const apiKey = secretFromCredential(context.credential);
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

function secretFromCredential(credential: StoredCredential): string | undefined {
  if (isOauthCredential(credential)) {
    return credential.access;
  }
  if (credential !== undefined && "key" in credential) {
    return credential.key;
  }
  return undefined;
}
