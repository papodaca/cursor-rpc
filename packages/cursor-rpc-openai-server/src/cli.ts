#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertListenReady, loadConfig } from "./config.js";
import { providerFromEnv } from "./provider.js";
import { startServer } from "./server.js";

export async function main(
  argv = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const config = loadConfig({ argv, env });
  assertListenReady(config);
  const provider = providerFromEnv(env);
  await startServer({ argv, env, config, provider });
}

function resolvedArgvEntry(entry: string): string {
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolvedArgvEntry(entry)).href;
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error && error.message.length > 0 ? error.message : "failed to start";
    console.error(message);
    process.exitCode = 1;
  });
}
