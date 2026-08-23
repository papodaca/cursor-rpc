import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { INBOUND_KEY } from "./helpers.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  name: string;
  bin: Record<string, string>;
};
const binName = Object.keys(pkg.bin)[0];
if (binName === undefined) {
  throw new Error("package.json is missing a bin entry");
}
const binPath = pkg.bin[binName];
if (binPath === undefined) {
  throw new Error(`package.json is missing bin.${binName}`);
}

const prefixes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const dir of prefixes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bin", () => {
  it("starts main() when invoked through an npm Unix .bin symlink", async () => {
    ensureBuilt();
    const prefix = mkdtempSync(join(tmpdir(), "cursor-rpc-openai-server-bin-"));
    prefixes.push(prefix);

    const nodeModules = join(prefix, "node_modules");
    const binDir = join(nodeModules, ".bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(packageRoot, join(nodeModules, pkg.name));
    symlinkSync(join("..", pkg.name, binPath.replace(/^\.\//, "")), join(binDir, binName));

    const child = spawn(process.execPath, [join(binDir, binName)], {
      env: {
        ...process.env,
        CURSOR_API_KEY: "key_test_symlink",
        CURSOR_RPC_OPENAI_API_KEY: INBOUND_KEY,
        CURSOR_RPC_OPENAI_HOST: "127.0.0.1",
        CURSOR_RPC_OPENAI_PORT: "0",
      },
    });
    children.push(child);

    const url = await readListenUrl(child);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

function ensureBuilt(): void {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`npm run build failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function readListenUrl(child: ChildProcess, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, url?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(url ?? "");
    };
    const timer = setTimeout(() => {
      finish(new Error(`timed out waiting for listen url\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
      const match = stdout.match(/https?:\/\/\S+/);
      if (match?.[0] !== undefined) {
        finish(undefined, match[0]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      finish(error);
    });
    child.once("exit", (code, signal) => {
      finish(new Error(`exited ${code ?? signal} before listen\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => {
      resolve();
    });
    child.kill("SIGTERM");
  });
}
