import { createProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { overflowHandler } from "./overflow.js";
import { cursorProviderInput } from "./provider.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerProvider(createProvider(cursorProviderInput()));
  pi.on("message_end", overflowHandler);
}
