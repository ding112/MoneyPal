import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const workspace = fileURLToPath(new URL("..", import.meta.url));

test("公共核心输入无需本地tarball即可准备且保留已验收来源", async () => {
  const root = await fixture();
  try {
    await execute(process.execPath, [join(root, "scripts/stage-core.mjs")]);
    const origin = JSON.parse(await readFile(join(root, "src/core-provenance.json"), "utf8"));
    const source = JSON.parse(await readFile(join(root, "core-source.json"), "utf8"));
    assert.equal(origin.name, "moneypal-core");
    assert.equal(origin.version, source.version);
    assert.equal(origin.tarballSha256, source.sha256);
    assert.deepEqual(await readFile(join(root, "src/core/CORE-SOURCE.json")), await readFile(join(root, "node_modules/moneypal-core/CORE-SOURCE.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("公共核心拒绝锁文件、来源记录和已安装内容篡改", async () => {
  for (const change of ["lock", "source", "installed"]) {
    const root = await fixture();
    try {
      if (change === "installed") {
        await writeFile(join(root, "node_modules/moneypal-core/dist/src/contracts.js"), "export const tampered = true;\n");
      } else {
        const path = join(root, change === "lock" ? "package-lock.json" : "core-source.json");
        const value = JSON.parse(await readFile(path, "utf8"));
        if (change === "lock") value.packages["node_modules/moneypal-core"].resolved = "file:other.tgz";
        else value.sourceRecordSha256 = "0".repeat(64);
        await writeFile(path, JSON.stringify(value));
      }
      await assert.rejects(execute(process.execPath, [join(root, "scripts/stage-core.mjs")]), (error) => error.code === 1);
      await assert.rejects(readFile(join(root, "src/core-provenance.json")), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-public-core-"));
  try {
    await mkdir(join(root, "scripts"));
    for (const name of ["package.json", "package-lock.json", "core-source.json", "scripts/stage-core.mjs", "scripts/core-files.mjs", "node_modules/moneypal-core"]) {
      await cp(join(workspace, name), join(root, name), { recursive: true });
    }
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
