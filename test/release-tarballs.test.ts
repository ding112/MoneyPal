import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

const execute = promisify(execFile);
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const { exportTarballs } = (await import(pathToFileURL(join(workspace, "scripts", "release-utils.mjs")).href)) as {
  exportTarballs: (items: Array<{ name: string; tarball: string }>, directory: string) => Promise<Array<{ name: string; exported: string }>>;
};

// 假 npm 只负责 pack/init/install，用来在不触碰真实 registry 与宿主运行时的前提下走完 tarball 验收。
const shim = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const args = process.argv.slice(2);
if (process.env.FAKE_NPM_LOG) appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + "\\n");
const [command] = args;

if (command === "pack") {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const destination = args[args.indexOf("--pack-destination") + 1];
  const files = manifest.name === "dsh-moneypal"
    ? ["README.md", "package.json", "index.js", "index.d.ts", "dist/src/finance/bridge.py", "dist/src/client.bundle.cjs"]
    : ["README.md", "package.json", "index.js", "index.d.ts", "dist/src/finance/bridge.py", "skills/mcp-moneypal/SKILL.md"];
  const staging = join(destination, manifest.name + "-pack");
  rmSync(staging, { recursive: true, force: true });
  for (const file of files) {
    mkdirSync(dirname(join(staging, file)), { recursive: true });
    writeFileSync(join(staging, file), file.endsWith(".json") ? "{}" : "fixture content\\n");
  }
  const filename = manifest.name + "-" + manifest.version + ".tgz";
  execFileSync("tar", ["-czf", join(destination, filename), "-C", staging, "."]);
  rmSync(staging, { recursive: true, force: true });
  process.stdout.write(JSON.stringify([{ filename, files: files.map((path) => ({ path })) }]));
  process.exit(0);
}
if (command === "init") {
  if (!existsSync(join(process.cwd(), "package.json"))) writeFileSync(join(process.cwd(), "package.json"), JSON.stringify({ name: "install-fixture", version: "1.0.0", private: true }));
  process.exit(0);
}
if (command === "install") {
  if (process.env.FAKE_NPM_FAIL_INSTALL === "1") {
    process.stderr.write("npm error code E500\\nnpm error install failed\\n");
    process.exit(1);
  }
  const file = args[args.length - 1].split("/").pop();
  const name = file.startsWith("dsh-moneypal") ? "dsh-moneypal" : "mcp-moneypal";
  const version = file.slice(name.length + 1, -4);
  const target = join(process.cwd(), "node_modules", name);
  mkdirSync(join(target, "dist", "src", "finance"), { recursive: true });
  writeFileSync(join(target, "package.json"), JSON.stringify({
    name,
    version,
    type: "module",
    exports: { ".": { types: "./index.d.ts", import: "./index.js" }, "./package.json": "./package.json" },
  }));
  writeFileSync(join(target, "index.js"), "export const fixture = true;\\n");
  writeFileSync(join(target, "index.d.ts"), "export declare const fixture: boolean;\\n");
  writeFileSync(join(target, "README.md"), "fixture\\n");
  writeFileSync(join(target, "dist", "src", "finance", "bridge.py"), "fixture content\\n");
  if (name === "dsh-moneypal") writeFileSync(join(target, "dist", "src", "client.bundle.cjs"), "module.exports = {};\\n");
  const bin = join(process.cwd(), "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, name), "process.exit(0);\\n");
  chmodSync(join(bin, name), 0o755);
  process.exit(0);
}
process.stderr.write("fake npm: unsupported " + args.join(" ") + "\\n");
process.exit(1);
`;

async function runTarballs(t: TestContext, extra: Record<string, string>) {
  const bin = await mkdtemp(join(tmpdir(), "moneypal-tarballs-bin-"));
  const parent = await mkdtemp(join(tmpdir(), "moneypal-tarballs-out-"));
  const output = join(parent, "moneypal-release");
  t.after(() => rm(bin, { recursive: true, force: true }));
  t.after(() => rm(parent, { recursive: true, force: true }));
  await writeFile(join(bin, "npm"), shim);
  await chmod(join(bin, "npm"), 0o755);
  try {
    const { stdout } = await execute(process.execPath, [join(workspace, "scripts", "release-tarballs.mjs")], {
      cwd: workspace,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, MONEYPAL_TARBALL_OUTPUT: output, ...extra },
    });
    return { code: 0, stdout, output };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? ""), output };
  }
}

test("导出函数按原文件名复制已验收的 tgz 字节", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "moneypal-export-source-"));
  const destination = await mkdtemp(join(tmpdir(), "moneypal-export-target-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const bytes = new Map<string, Buffer>();
  for (const name of ["dsh-moneypal", "mcp-moneypal"]) {
    const content = Buffer.from(`accepted tarball bytes for ${name}`);
    bytes.set(name, content);
    await writeFile(join(source, `${name}-1.2.3.tgz`), content);
  }

  const exported = await exportTarballs([...bytes].map(([name]) => ({ name, tarball: join(source, `${name}-1.2.3.tgz`) })), join(destination, "nested"));

  for (const [name, content] of bytes) {
    const target = join(destination, "nested", `${name}-1.2.3.tgz`);
    assert.equal(exported.find((item) => item.name === name)?.exported, target);
    assert.deepEqual(await readFile(target), content, "导出的字节必须与已验收的 tgz 完全一致。");
  }
});

test("验收通过时把两个 tgz 导出到 MONEYPAL_TARBALL_OUTPUT 且字节与验收结果一致", async (t) => {
  const result = await runTarballs(t, {});

  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { ok: boolean; output: string; packages: Array<{ name: string; tarball: string; integrity: string }> };
  assert.equal(report.ok, true);
  assert.equal(report.output, result.output);
  assert.equal(report.packages.length, 2);
  assert.deepEqual((await readdir(result.output)).sort(), report.packages.map((item) => basename(item.tarball)).sort());
  for (const item of report.packages) {
    const bytes = await readFile(join(result.output, basename(item.tarball)));
    assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, item.integrity, "导出文件必须与验收过的 tgz 字节一致。");
  }
});

test("任一验收失败时不导出任何候选 tgz", async (t) => {
  const result = await runTarballs(t, { FAKE_NPM_FAIL_INSTALL: "1" });

  assert.notEqual(result.code, 0);
  await assert.rejects(access(result.output), "验收失败时不得创建导出目录。");
});
