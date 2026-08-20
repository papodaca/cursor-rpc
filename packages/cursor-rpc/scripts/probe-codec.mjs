#!/usr/bin/env node
/**
 * Optional live codec probe. Never prints tokens or API keys.
 * Skip unless CURSOR_API_KEY or CURSOR_AUTH_TOKEN is set.
 */
const hasKey = Boolean(process.env.CURSOR_API_KEY);
const hasToken = Boolean(process.env.CURSOR_AUTH_TOKEN);

if (!hasKey && !hasToken) {
  console.log("probe:codec skipped (set CURSOR_API_KEY or CURSOR_AUTH_TOKEN to run)");
  process.exit(0);
}

console.log(
  "probe:codec: credentials detected; live JSON vs 415 vs binary recording is not yet wired (auth lands in a later unit).",
);
process.exit(0);
