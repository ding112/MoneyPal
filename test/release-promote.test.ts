import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

const execute = promisify(execFile);
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const bridge = "print('canonical bridge fixture')\n";

const shim = `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const args = process.argv.slice(2);
const log = process.env.FAKE_NPM_LOG;
if (log) appendFileSync(log, JSON.stringify(args) + "\\n");
const version = process.env.FAKE_NPM_VERSION || "1.0.0";
const latestFile = process.env.FAKE_NPM_STATE;
const readLatest = () => existsSync(latestFile) ? readFileSync(latestFile, "utf8").trim() : (process.env.FAKE_NPM_LATEST || "0.0.1");

if (args[0] === "view") {
  const name = args[1].split("@")[0];
  const shown = process.env.FAKE_NPM_WRONG_VERSION === name ? "0.0.0" : version;
  process.stdout.write(JSON.stringify({ version: shown, "dist-tags": { latest: readLatest(), next: version } }));
  process.exit(0);
}
if (args[0] === "pack") {
  const name = args[1].split("@")[0];
  const destination = args[args.indexOf("--pack-destination") + 1];
  const staging = join(destination, name + "-staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "package", "dist", "src", "finance"), { recursive: true });
  writeFileSync(join(staging, "package", "package.json"), JSON.stringify({ name, version, exports: { ".": "./index.js", "./package.json": "./package.json" } }));
  writeFileSync(join(staging, "package", "dist", "src", "finance", "bridge.py"), process.env.FAKE_NPM_BRIDGE || "");
  const filename = name + "-" + version + ".tgz";
  execFileSync("tar", ["-czf", join(destination, filename), "-C", staging, "package"]);
  rmSync(staging, { recursive: true, force: true });
  process.stdout.write(JSON.stringify([{ filename }]));
  process.exit(0);
}
if (args[0] === "dist-tag" && args[1] === "add") {
  const name = args[2].split("@")[0];
  if (process.env.FAKE_NPM_FAIL_DISTTAG === name) {
    process.stderr.write("npm error code E500\\nnpm error dist-tag failed\\n");
    process.exit(1);
  }
  writeFileSync(latestFile, version);
  process.exit(0);
}
process.stderr.write("fake npm: unsupported " + args.join(" ") + "\\n");
process.exit(1);
`;

async function fixture(t: TestContext, variant: "rc" | "stable") {
  const root = await mkdtemp(join(tmpdir(), `moneypal-promote-${variant}-`));
  const bin = await mkdtemp(join(tmpdir(), "moneypal-promote-bin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(bin, { recursive: true, force: true }));

  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(`${workspace}/scripts/release-promote.mjs`, join(root, "scripts", "release-promote.mjs"));
  await copyFile(`${workspace}/scripts/release-utils.mjs`, join(root, "scripts", "release-utils.mjs"));
  await copyFile(`${workspace}/test/fixtures/release-promote-${variant}/package.json`, join(root, "package.json"));
  await mkdir(join(root, "dist", "packages", "dsh-moneypal", "dist", "src", "finance"), { recursive: true });
  await writeFile(join(root, "dist", "packages", "dsh-moneypal", "dist", "src", "finance", "bridge.py"), bridge);

  await writeFile(join(bin, "npm"), shim);
  await chmod(join(bin, "npm"), 0o755);
  const log = join(root, "npm-calls.jsonl");
  const state = join(root, "npm-latest.txt");
  const run = async (args: string[] = [], extra: Record<string, string> = {}) => {
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_NPM_LOG: log,
      FAKE_NPM_STATE: state,
      FAKE_NPM_BRIDGE: bridge,
      ...extra,
    };
    try {
      const { stdout, stderr } = await execute(process.execPath, [join(root, "scripts", "release-promote.mjs"), ...args], { cwd: root, env });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failure.code ?? -1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? "") };
    }
  };
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { root, run, calls, log, state };
}

test("RC fixture 被稳定版提升门禁拒绝且不触碰 registry", async (t) => {
  const { run, calls, log } = await fixture(t, "rc");

  const result = await run();

  assert.equal(result.code, 1);
  assert.match(result.stderr, /提升只允许稳定版本/u);
  await assert.rejects(access(log), "RC 版本被拒绝时不得调用 npm。");
  assert.deepEqual(await calls(), []);
});

test("dry-run 只输出 dist-tag 命令，绝不写 registry", async (t) => {
  const { run, calls, state } = await fixture(t, "stable");

  const result = await run();

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout) as { ok: boolean; action: string; next: string[] };
  assert.equal(output.ok, true);
  assert.equal(output.action, "dry-run");
  assert.deepEqual(output.next, ["npm dist-tag add dsh-moneypal@1.0.0 latest", "npm dist-tag add mcp-moneypal@1.0.0 latest"]);
  const invocations = await calls();
  assert.equal(invocations.some((args) => args[0] === "dist-tag"), false, "dry-run 不得执行 dist-tag。");
  await assert.rejects(access(state), "dry-run 不得改动 latest 状态。");
  assert.equal(invocations.filter((args) => args[0] === "view").length, 2);
  assert.equal(invocations.filter((args) => args[0] === "pack").length, 2);
});

test("--apply 在两个包全部复验通过后依次提升 latest", async (t) => {
  const { run, calls, state } = await fixture(t, "stable");

  const result = await run(["--apply"]);

  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout) as { action: string; verified: Array<{ name: string; latest: string }> };
  assert.equal(output.action, "applied");
  assert.deepEqual(output.verified, [
    { name: "dsh-moneypal", latest: "1.0.0" },
    { name: "mcp-moneypal", latest: "1.0.0" },
  ]);
  assert.deepEqual((await calls()).filter((args) => args[0] === "dist-tag"), [
    ["dist-tag", "add", "dsh-moneypal@1.0.0", "latest"],
    ["dist-tag", "add", "mcp-moneypal@1.0.0", "latest"],
  ]);
  assert.equal((await readFile(state, "utf8")).trim(), "1.0.0");
});

test("复验失败时在写操作之前停止", async (t) => {
  const { run, calls, state } = await fixture(t, "stable");

  const result = await run(["--apply"], { FAKE_NPM_WRONG_VERSION: "mcp-moneypal" });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /registry 版本应为 1\.0\.0/u);
  assert.equal((await calls()).some((args) => args[0] === "dist-tag"), false, "复验失败时不得执行 dist-tag。");
  await assert.rejects(access(state), "复验失败时不得改动 latest 状态。");
});

test("dist-tag 部分失败时如实报错且不输出整体成功", async (t) => {
  const { run, calls } = await fixture(t, "stable");

  const result = await run(["--apply"], { FAKE_NPM_FAIL_DISTTAG: "mcp-moneypal" });

  assert.equal(result.code, 1);
  assert.equal(result.stdout.trim(), "", "部分失败时不得输出整体成功的 JSON。");
  const report = JSON.parse(result.stderr) as { ok: boolean; action: string; applied: string[]; failed: Array<{ name: string }> };
  assert.equal(report.ok, false);
  assert.equal(report.action, "apply-failed");
  assert.deepEqual(report.applied, ["dsh-moneypal"]);
  assert.deepEqual(report.failed.map(({ name }) => name), ["mcp-moneypal"]);
  assert.deepEqual((await calls()).filter((args) => args[0] === "dist-tag"), [
    ["dist-tag", "add", "dsh-moneypal@1.0.0", "latest"],
    ["dist-tag", "add", "mcp-moneypal@1.0.0", "latest"],
  ]);
});
