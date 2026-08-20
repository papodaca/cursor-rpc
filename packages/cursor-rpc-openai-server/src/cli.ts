import { startServer } from "./server.js";

export async function main(argv = process.argv.slice(2), env = process.env): Promise<void> {
  await startServer({ argv, env });
}
