import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createWebClient, type WebClient } from "cursor-rpc";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { createWebSearchTool } from "./tools/web-search.js";

export type CreateExtensionOptions = {
  client?: WebClient;
  now?: () => Date;
};

export function createExtension(options: CreateExtensionOptions = {}) {
  return (pi: ExtensionAPI) => {
    const client = options.client ?? createWebClient();
    const shared = {
      client,
      now: options.now ?? (() => new Date()),
      truncate: truncateHead,
      formatSize,
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    };
    pi.registerTool(createWebFetchTool(shared));
    pi.registerTool(createWebSearchTool(shared));
    pi.on("session_shutdown", () => {
      client.close();
    });
  };
}

export default createExtension();
