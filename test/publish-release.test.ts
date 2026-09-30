import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

const execute = promisify(execFile);
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const { publishRelease, tarballIntegrity } = (await import(pathToFileURL(join(workspace, "scripts", "publish-release.mjs")).href)) as typeof import("../scripts/publish-release.mjs");
const name = "dsh-moneypal";
const version = "9.9.9-rc.1";

interface RegistryAnswer { stdout?: string; failure?: string; }

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "moneypal-publish-tarballs-"));
  const root = await mkdtemp(join(tmpdir(), "moneypal-publish-root-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "moneypal-workspace", version }));
  const bytes = Buffer.from(`audited tarball for ${name}@${version}`);
  await writeFile(join(directory, `${name}-${version}.tgz`), bytes);
  return { directory, root, bytes };
}

function fakeNpm(answers: RegistryAnswer[]) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  let queue = [...answers];
  let publishFailure: string | undefined;
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args[0] === "publish") {
      if (publishFailure) throw Object.assign(new Error("fake npm publish failed"), { stderr: publishFailure, code: 1 });
      return { stdout: "+ published", stderr: "" };
    }
    const answer = queue.length > 1 ? queue.shift()! : queue[0] ?? { stdout: "{}" };
    if (answer.failure) throw Object.assign(new Error("fake npm view failed"), { stderr: answer.failure, code: 1 });
    return { stdout: answer.stdout ?? "", stderr: "" };
  };
  return {
    exec,
    calls,
    sleeps,
    sleep: async (milliseconds: number) => { sleeps.push(milliseconds); },
    failPublish: (stderr: string) => { publishFailure = stderr; },
  };
}

const e404: RegistryAnswer = { failure: "npm error code E404\nnpm error 404 Not Found" };
const network: RegistryAnswer = { failure: "npm error code EAI_AGAIN\nnpm error network request failed" };
const exists = (integrity: string | null): RegistryAnswer => ({ stdout: JSON.stringify({ version, dist: integrity === null ? {} : { integrity } }) });
const publishedFiles = (calls: string[][]) => calls.filter((call) => call[1] === "publish").map((call) => String(call[2]).split("/").pop());

test("发布不存在的 DSH 版本并复验 tarball integrity", async (t) => {
  const { directory, root, bytes } = await fixture(t);
  const npm = fakeNpm([e404, exists(tarballIntegrity(bytes))]);
  const result = await publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep });

  assert.equal(result.ok, true);
  assert.equal(result.version, version);
  assert.deepEqual(result.packages, [{ name, status: "published", integrity: tarballIntegrity(bytes) }]);
  assert.deepEqual(publishedFiles(npm.calls), [`${name}-${version}.tgz`]);
  const publish = npm.calls.find((call) => call[1] === "publish")!;
  assert.ok(publish.includes("--access") && publish.includes("public"));
  assert.ok(publish.includes("--tag") && publish.includes("next"));
  assert.ok(publish.includes("--provenance"));
  assert.ok(publish.includes("--registry") && publish.includes("https://registry.npmjs.org/"));
  assert.deepEqual(npm.sleeps, []);
});

test("registry 已有相同 DSH tarball 时跳过发布", async (t) => {
  const { directory, root, bytes } = await fixture(t);
  const npm = fakeNpm([exists(tarballIntegrity(bytes))]);
  const result = await publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep });

  assert.deepEqual(result.packages, [{ name, status: "skipped", integrity: tarballIntegrity(bytes) }]);
  assert.deepEqual(publishedFiles(npm.calls), []);
});

test("integrity 冲突、网络错误和无效响应均在发布前失败", async (t) => {
  const { directory, root } = await fixture(t);
  for (const answer of [exists("sha512-conflict"), network, { stdout: "not json" }]) {
    const npm = fakeNpm([answer]);
    await assert.rejects(publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep }));
    assert.deepEqual(publishedFiles(npm.calls), []);
  }
});

test("发布后短暂未出现时重试 registry integrity 检查", async (t) => {
  const { directory, root, bytes } = await fixture(t);
  const npm = fakeNpm([e404, e404, exists(tarballIntegrity(bytes))]);
  const result = await publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep });

  assert.deepEqual(result.packages.map(({ status }) => status), ["published"]);
  assert.deepEqual(npm.sleeps, [5000]);
});

test("缺少已验收 tgz 时不调用 npm", async (t) => {
  const { root } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "moneypal-publish-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const npm = fakeNpm([]);

  await assert.rejects(publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep }), /缺少已验收的 tarball/u);
  assert.deepEqual(npm.calls, []);
});

test("命令行只接受 --dir <目录>", async () => {
  const script = join(workspace, "scripts", "publish-release.mjs");
  for (const args of [[], ["--dir"], ["--dir", "/tmp", "extra"], ["--output", "/tmp"]]) {
    await assert.rejects(
      execute(process.execPath, [script, ...args], { cwd: workspace }),
      (error: { code?: number; stderr?: string }) => error instanceof Error && error.code === 1 && /用法：node scripts\/publish-release\.mjs --dir/u.test(String(error.stderr)),
    );
  }
});
