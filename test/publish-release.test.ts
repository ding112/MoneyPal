import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";

const execute = promisify(execFile);
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const { publishRelease, tarballIntegrity } = (await import(pathToFileURL(join(workspace, "scripts", "publish-release.mjs")).href)) as typeof import("../scripts/publish-release.mjs");

const version = "9.9.9-rc.1";
const names = ["dsh-moneypal", "mcp-moneypal"];

interface RegistryAnswer { stdout?: string; failure?: string; }

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "moneypal-publish-tarballs-"));
  const root = await mkdtemp(join(tmpdir(), "moneypal-publish-root-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "moneypal-workspace", version }));
  const bytes = new Map<string, Buffer>();
  for (const name of names) {
    const content = Buffer.from(`audited tarball for ${name}@${version}`);
    bytes.set(name, content);
    await writeFile(join(directory, `${name}-${version}.tgz`), content);
  }
  return { directory, root, bytes };
}

function fakeNpm(answers: Map<string, RegistryAnswer[]>) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const publishFailure = new Map<string, string>();
  const queues = new Map([...answers].map(([name, queue]) => [name, [...queue]]));
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (args[0] === "publish") {
      const failure = publishFailure.get(String(args[1]).split("/").pop()!);
      if (failure) throw Object.assign(new Error("fake npm publish failed"), { stderr: failure, code: 1 });
      return { stdout: "+ published", stderr: "" };
    }
    const name = names.find((candidate) => args.some((argument) => argument.startsWith(`${candidate}@`)))!;
    const queue = queues.get(name) ?? [];
    const answer = queue.length > 1 ? queue.shift()! : queue[0] ?? { stdout: "{}" };
    if (answer.failure) throw Object.assign(new Error("fake npm view failed"), { stderr: answer.failure, code: 1 });
    return { stdout: answer.stdout ?? "", stderr: "" };
  };
  return {
    exec,
    calls,
    sleeps,
    sleep: async (milliseconds: number) => { sleeps.push(milliseconds); },
    failPublish: (file: string, stderr: string) => publishFailure.set(file, stderr),
  };
}

const e404: RegistryAnswer = { failure: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/x - Not found\nnpm error 404 'x@9.9.9-rc.1' is not in this registry." };
const network: RegistryAnswer = { failure: "npm error code EAI_AGAIN\nnpm error network request to https://registry.npmjs.org/ failed" };
const auth: RegistryAnswer = { failure: "npm error code E401\nnpm error Unable to authenticate" };
const rateLimited: RegistryAnswer = { failure: "npm error code E429\nnpm error Too Many Requests" };
const exists = (integrity: string | null): RegistryAnswer => ({ stdout: JSON.stringify({ version, dist: integrity === null ? {} : { integrity } }) });
const publishedFiles = (calls: string[][]) => calls.filter((call) => call[1] === "publish").map((call) => String(call[2]).split("/").pop());
const viewsFor = (calls: string[][], name: string) => calls.filter((call) => call[1] === "view" && call.some((argument) => argument.startsWith(`${name}@`))).length;

test("两个包都不存在时按顺序发布并复验 integrity", async (t) => {
  const { directory, root, bytes } = await fixture(t);
  const npm = fakeNpm(new Map([
    [names[0], [e404, exists(tarballIntegrity(bytes.get(names[0])!))]],
    [names[1], [e404, exists(tarballIntegrity(bytes.get(names[1])!))]],
  ]));

  const result = await publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep });

  assert.equal(result.ok, true);
  assert.equal(result.version, version);
  assert.equal(result.registry, "https://registry.npmjs.org/");
  assert.deepEqual(result.packages, names.map((name) => ({ name, status: "published", integrity: tarballIntegrity(bytes.get(name)!) })));
  assert.deepEqual(publishedFiles(npm.calls), [`${names[0]}-${version}.tgz`, `${names[1]}-${version}.tgz`]);
  for (const call of npm.calls.filter((entry) => entry[1] === "publish")) {
    assert.ok(call.includes("--access") && call.includes("public"));
    assert.ok(call.includes("--tag") && call.includes("next"));
    assert.ok(call.includes("--provenance"));
    assert.ok(call.includes("--registry") && call.includes("https://registry.npmjs.org/"));
  }
  assert.equal(npm.calls.some((call) => call.includes("dist-tag")), false, "发布脚本不得改动 dist-tag。");
  assert.deepEqual(npm.sleeps, []);
});

test("单包已存在且 integrity 一致时只发布缺失的包", async (t) => {
  const { directory, root, bytes } = await fixture(t);
  const npm = fakeNpm(new Map([
    [names[0], [exists(tarballIntegrity(bytes.get(names[0])!))]],
    [names[1], [e404, exists(tarballIntegrity(bytes.get(names[1])!))]],
  ]));

  const result = await publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep });

  assert.deepEqual(result.packages.map(({ name, status }) => [name, status]), [[names[0], "skipped"], [names[1], "published"]]);
  assert.deepEqual(publishedFiles(npm.calls), [`${names[1]}-${version}.tgz`]);
});

test("两包都已存在时全部跳过且不调用 npm publish", async (t) => {
  const { directory, root, bytes } = await fixture(t);
  const npm = fakeNpm(new Map([
    [names[0], [exists(tarballIntegrity(bytes.get(names[0])!))]],
    [names[1], [exists(tarballIntegrity(bytes.get(names[1])!))]],
  ]));

  const result = await publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep });

  assert.deepEqual(result.packages.map(({ status }) => status), ["skipped", "skipped"]);
  assert.deepEqual(publishedFiles(npm.calls), []);
});

test("integrity 冲突或缺失时失败且不发布任何包", async (t) => {
  const { directory, root } = await fixture(t);

  for (const conflict of ["sha512-conflict", null]) {
    const npm = fakeNpm(new Map([[names[0], [exists(conflict)]], [names[1], [e404]]]));
    await assert.rejects(publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep }), /integrity 不一致/u);
    assert.deepEqual(publishedFiles(npm.calls), [], "integrity 冲突时不得发布任何包。");
  }
});

test("网络、鉴权、限流与响应解析错误都不当作 E404", async (t) => {
  const { directory, root } = await fixture(t);

  for (const failure of [network, auth, rateLimited]) {
    const npm = fakeNpm(new Map([[names[0], [failure]], [names[1], [e404]]]));
    await assert.rejects(publishRelease({ directory, root, exec: npm.exec, sleep: npm.sleep }), /查询 dsh-moneypal@9\.9\.9-rc\.1 失败/u);
    assert.deepEqual(publishedFiles(npm.calls), []);
  }

  const broken = fakeNpm(new Map([[names[0], [{ stdout: "not json" }]], [names[1], [e404]]]));
  await assert.rejects(publishRelease({ directory, root, exec: broken.exec, sleep: broken.sleep }), /解析 dsh-moneypal@9\.9\.9-rc\.1 的 registry 响应失败/u);
  assert.deepEqual(publishedFiles(broken.calls), []);
});

test("第二个包发布失败时报错，重试只发布缺失包", async (t) => {
  const { directory, root, bytes } = await fixture(t);

  const first = fakeNpm(new Map([
    [names[0], [e404, exists(tarballIntegrity(bytes.get(names[0])!))]],
    [names[1], [e404]],
  ]));
  first.failPublish(`${names[1]}-${version}.tgz`, "npm error code E500\nnpm error internal server error");
  await assert.rejects(
    publishRelease({ directory, root, exec: first.exec, sleep: first.sleep }),
    (error: Error) => /发布 mcp-moneypal@9\.9\.9-rc\.1 失败/u.test(error.message)
      && /已发布 dsh-moneypal/u.test(error.message)
      && /仍待发布 mcp-moneypal/u.test(error.message)
      && /重试/u.test(error.message),
  );
  assert.deepEqual(publishedFiles(first.calls), [`${names[0]}-${version}.tgz`, `${names[1]}-${version}.tgz`]);

  const retry = fakeNpm(new Map([
    [names[0], [exists(tarballIntegrity(bytes.get(names[0])!))]],
    [names[1], [e404, exists(tarballIntegrity(bytes.get(names[1])!))]],
  ]));
  const result = await publishRelease({ directory, root, exec: retry.exec, sleep: retry.sleep });
  assert.deepEqual(result.packages.map(({ name, status }) => [name, status]), [[names[0], "skipped"], [names[1], "published"]]);
  assert.deepEqual(publishedFiles(retry.calls), [`${names[1]}-${version}.tgz`]);
});

test("发布后复验最多重试六次、间隔五秒", async (t) => {
  const { directory, root, bytes } = await fixture(t);
  const localIntegrity = tarballIntegrity(bytes.get(names[0])!);

  const delayed = fakeNpm(new Map([
    [names[0], [e404, e404, exists(localIntegrity)]],
    [names[1], [exists(tarballIntegrity(bytes.get(names[1])!))]],
  ]));
  const delayedResult = await publishRelease({ directory, root, exec: delayed.exec, sleep: delayed.sleep });
  assert.deepEqual(delayedResult.packages.map(({ status }) => status), ["published", "skipped"]);
  assert.deepEqual(delayed.sleeps, [5000]);
  assert.equal(viewsFor(delayed.calls, names[0]), 3, "一次检查、一次未命中、一次命中。");

  const never = fakeNpm(new Map([
    [names[0], [e404, exists("sha512-other")]],
    [names[1], [exists(tarballIntegrity(bytes.get(names[1])!))]],
  ]));
  await assert.rejects(publishRelease({ directory, root, exec: never.exec, sleep: never.sleep }), /发布后复验失败/u);
  assert.deepEqual(never.sleeps, [5000, 5000, 5000, 5000, 5000]);
  assert.equal(viewsFor(never.calls, names[0]), 7, "复验读请求最多六次。");
  for (const call of never.calls.filter((entry) => entry[1] === "view")) {
    assert.ok(call.includes("--prefer-online"), "复验必须绕过本地缓存，避免读到发布前的 404。");
  }
});

test("缺少已验收 tgz 时在调用 npm 之前失败", async (t) => {
  const { root } = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "moneypal-publish-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const npm = fakeNpm(new Map());

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
