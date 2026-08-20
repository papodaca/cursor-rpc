import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const serverDir = path.join(root, "apps", "cursor-rpc-openai-server");
const libDir = path.join(root, "packages", "cursor-rpc");
const piDir = path.join(root, "packages", "cursor-rpc-pi");
const toolsDir = path.join(root, "packages", "cursor-rpc-pi-tools");
const distDir = path.join(libDir, "dist");
const linkPath = path.join(root, "node_modules", "cursor-rpc");
const toolsLinkPath = path.join(root, "node_modules", "cursor-rpc-pi-tools");

function importFrom(cwd, source) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd,
    encoding: "utf8",
  });
}

function importCursorRpcFromServer() {
  return importFrom(serverDir, "import { name } from 'cursor-rpc'; console.log(name);");
}

function importCreateWebClientFromTools() {
  return importFrom(
    toolsDir,
    "import { createWebClient } from 'cursor-rpc'; console.log(typeof createWebClient);",
  );
}

function collectTs(dir) {
  const chunks = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      chunks.push(collectTs(file));
    } else if (entry.name.endsWith(".ts")) {
      chunks.push(readFileSync(file, "utf8"));
    }
  }
  return chunks.join("\n");
}

describe("workspace link", () => {
  it("resolves cursor-rpc to the local workspace symlink", () => {
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(realpathSync(linkPath), realpathSync(libDir));
  });

  it("symlinks the tools workspace", () => {
    assert.equal(lstatSync(toolsLinkPath).isSymbolicLink(), true);
    assert.equal(realpathSync(toolsLinkPath), realpathSync(toolsDir));
  });

  it("loads the stub export from the server workspace after library build", () => {
    const result = importCursorRpcFromServer();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "cursor-rpc");
  });

  it("imports createWebClient from the tools workspace after library build", () => {
    const result = importCreateWebClientFromTools();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "function");
  });

  it("does not map cursor-rpc to src via tsconfig paths", () => {
    const configs = [
      path.join(root, "tsconfig.base.json"),
      path.join(libDir, "tsconfig.json"),
      path.join(piDir, "tsconfig.json"),
      path.join(toolsDir, "tsconfig.json"),
      path.join(serverDir, "tsconfig.json"),
    ];
    for (const file of configs) {
      const json = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(json.compilerOptions?.paths, undefined, file);
    }
  });

  it("keeps web tool Pi package identity on tools, not on the provider", () => {
    const tools = JSON.parse(readFileSync(path.join(toolsDir, "package.json"), "utf8"));
    assert.equal(tools.keywords?.includes("pi-package"), true);
    assert.deepEqual(tools.pi?.extensions, ["./src/index.ts"]);
    assert.match(tools.dependencies?.["cursor-rpc"] ?? "", /^\^1\.0\.0$/);
    const providerSrc = collectTs(path.join(piDir, "src"));
    assert.equal(providerSrc.includes("web_fetch"), false);
    assert.equal(providerSrc.includes("web_search"), false);
  });

  it("fails to import when dist is missing, then succeeds after restore", () => {
    assert.equal(existsSync(distDir), true);
    const parked = `${distDir}.parked`;
    renameSync(distDir, parked);
    try {
      const missingServer = importCursorRpcFromServer();
      assert.notEqual(missingServer.status, 0);
      assert.match(
        missingServer.stderr,
        /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/,
      );
      const missingTools = importCreateWebClientFromTools();
      assert.notEqual(missingTools.status, 0);
      assert.match(
        missingTools.stderr,
        /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/,
      );
    } finally {
      if (existsSync(parked)) {
        renameSync(parked, distDir);
      }
    }
    const restoredServer = importCursorRpcFromServer();
    assert.equal(restoredServer.status, 0, restoredServer.stderr);
    assert.equal(restoredServer.stdout.trim(), "cursor-rpc");
    const restoredTools = importCreateWebClientFromTools();
    assert.equal(restoredTools.status, 0, restoredTools.stderr);
    assert.equal(restoredTools.stdout.trim(), "function");
  });
});
