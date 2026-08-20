import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const serverDir = path.join(root, "apps", "cursor-rpc-openai-server");
const libDir = path.join(root, "packages", "cursor-rpc");
const distDir = path.join(libDir, "dist");
const linkPath = path.join(root, "node_modules", "cursor-rpc");

function importCursorRpcFromServer() {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import { name } from 'cursor-rpc'; console.log(name);"],
    { cwd: serverDir, encoding: "utf8" },
  );
}

describe("workspace link", () => {
  it("resolves cursor-rpc to the local workspace symlink", () => {
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(realpathSync(linkPath), realpathSync(libDir));
  });

  it("loads the stub export from the server workspace after library build", () => {
    const result = importCursorRpcFromServer();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "cursor-rpc");
  });

  it("does not map cursor-rpc to src via tsconfig paths", () => {
    const configs = [
      path.join(root, "tsconfig.base.json"),
      path.join(libDir, "tsconfig.json"),
      path.join(root, "packages", "cursor-rpc-pi", "tsconfig.json"),
      path.join(serverDir, "tsconfig.json"),
    ];
    for (const file of configs) {
      const json = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(json.compilerOptions?.paths, undefined, file);
    }
  });

  it("fails to import when dist is missing, then succeeds after restore", () => {
    assert.equal(existsSync(distDir), true);
    const parked = `${distDir}.parked`;
    renameSync(distDir, parked);
    try {
      const missing = importCursorRpcFromServer();
      assert.notEqual(missing.status, 0);
      assert.match(
        missing.stderr,
        /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/,
      );
    } finally {
      if (existsSync(parked)) {
        renameSync(parked, distDir);
      }
    }
    const restored = importCursorRpcFromServer();
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(restored.stdout.trim(), "cursor-rpc");
  });
});
