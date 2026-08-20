import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@earendil-works/pi-ai": fileURLToPath(new URL("./test/stubs/pi-ai.ts", import.meta.url)),
      "@earendil-works/pi-coding-agent": fileURLToPath(new URL("./test/stubs/pi-coding-agent.ts", import.meta.url)),
    },
  },
});
