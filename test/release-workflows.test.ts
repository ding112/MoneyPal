import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workspace = fileURLToPath(new URL("../..", import.meta.url));
const checkout = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const setupNode = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";

const read = (path: string) => readFile(`${workspace}/.github/workflows/${path}`, "utf8");
const count = (text: string, pattern: RegExp) => (text.match(pattern) ?? []).length;

test("Test 工作流只读、固定工具链、只构建一次并先准备运行时再跑发布验收", async () => {
  const workflow = await read("test.yml");

  assert.match(workflow, /permissions:\n  contents: read\n/u, "Test 工作流只授予读取权限。");
  assert.doesNotMatch(workflow, /contents: write/u);
  assert.doesNotMatch(workflow, /id-token: write/u);
  assert.doesNotMatch(workflow, /NPM_TOKEN/u, "Test 工作流不得读取 NPM_TOKEN。");
  assert.doesNotMatch(workflow, /--if-present/u, "必需门禁不得用 --if-present 掩盖。");
  assert.ok(workflow.includes(checkout), "必须固定 actions/checkout v6。");
  assert.ok(workflow.includes(setupNode), "必须固定 actions/setup-node v6。");
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /node-version: 24/u);
  assert.match(workflow, /npm install -g npm@11\.14\.1/u);
  assert.match(workflow, /cache: npm/u);
  assert.match(workflow, /timeout-minutes: 30/u);
  assert.match(workflow, /^  test:$/mu, "保留 test job 名称，避免改变分支保护的检查名。");
  assert.match(workflow, /cancel-in-progress: true/u, "同一 ref 的旧任务应被取消。");

  assert.match(workflow, /pull_request:\n    types: \[opened, synchronize, reopened\]\n/u);
  assert.doesNotMatch(workflow, /edited/u, "版本不再从提交类型推导，PR 编辑不再触发。");
  assert.doesNotMatch(workflow, /PR_TITLE|Conventional Commits/u, "不再检查 PR 标题。");

  const install = workflow.indexOf("run: npm ci");
  const build = workflow.indexOf("run: npm run build");
  const runtime = workflow.indexOf("node dist/src/main.js setup-runtime");
  const gates = workflow.indexOf("run: npm run verify:release:built");
  assert.ok(install >= 0 && build > install && runtime > build && gates > runtime, "顺序必须是 npm ci → build → setup-runtime → verify:release:built。");
  assert.equal(count(workflow, /run: npm run build\n/gu), 1, "每个 job 只完整构建一次。");
  assert.doesNotMatch(workflow, /npm run test:release/u, "验收链路使用 verify:release:built，避免重复构建。");
  assert.match(workflow, /node dist\/src\/main\.js setup-runtime/u, "发布门禁要求真实运行时，工作流必须先准备运行时。");
});

test("Release 工作流只接受 v* tag、最小权限、OIDC 发布并复用已验收 tgz", async () => {
  const workflow = await read("release.yml");

  assert.match(workflow, /on:\n  push:\n    tags: \["v\*"\]\n/u, "只接受 tag 触发。");
  assert.doesNotMatch(workflow, /workflow_dispatch|inputs:/u, "发布不再支持手动 dispatch。");
  assert.doesNotMatch(workflow, /branches:/u, "发布不再由 main push 触发。");

  assert.match(workflow, /permissions:\n  contents: read\n  id-token: write\n/u, "发布只需要读取源码与 OIDC 令牌。");
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|issues: write/u);
  assert.match(workflow, /concurrency:\n  group: release-main\n  cancel-in-progress: false\n/u);
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /node-version: 24/u);
  assert.match(workflow, /npm install -g npm@11\.14\.1/u);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org\//u);
  assert.match(workflow, /package-manager-cache: false/u);
  assert.doesNotMatch(workflow, /^          cache: npm$/mu, "Release 工作流不启用依赖缓存。");
  assert.doesNotMatch(workflow, /^    environment:/mu, "本期不绑定 environment。");
  assert.ok(workflow.includes(checkout), "必须固定 actions/checkout v6。");
  assert.ok(workflow.includes(setupNode), "必须固定 actions/setup-node v6。");
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u, "必须检出本次事件的提交。");
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /persist-credentials: false/u);

  assert.doesNotMatch(workflow, /release-please|release_created|steps\.release/u, "不再调用 Release Please。");
  assert.doesNotMatch(workflow, /gh release view|gh release create/u, "不再检查或创建 GitHub Release。");
  assert.doesNotMatch(workflow, /1\.0\.0-rc\.3/u, "不再保留历史 rc.3 门槛。");
  assert.doesNotMatch(workflow, /GITHUB_STEP_SUMMARY/u, "删除自定义发布 Summary。");
  assert.doesNotMatch(workflow, /\|\s*tee\b/u, "发布命令不得经 tee 管道，非零退出必须直接使 job 失败。");

  // ref 只经环境变量传入 shell，不得把表达式插入命令源码。
  const refLines = workflow.split("\n").filter((line) => line.includes("github.ref"));
  assert.ok(refLines.length > 0, "必须把触发 ref 传给校验步骤。");
  refLines.forEach((line) => assert.match(line, /^\s+RELEASE_REF: \$\{\{ github\.ref \}\}$/u, "ref 只能经环境变量传入。"));
  assert.match(workflow, /git fetch --no-tags origin main/u, "rc/稳定版必须显式获取远端 main。");
  assert.match(workflow, /git merge-base --is-ancestor/u, "rc/稳定版必须检查 tag 提交在 main 历史中。");

  assert.match(workflow, /\n        env:\n          MONEYPAL_TARBALL_OUTPUT: \$\{\{ runner\.temp \}\}\/moneypal-release\n        run: npm run verify:release:built\n/u, "产物目录必须通过验收步骤的 step 级环境变量传递。");
  assert.match(workflow, /run: npm run verify:release:built/u);
  assert.match(workflow, /run: npm run release:preflight/u);
  assert.match(workflow, /run: node scripts\/publish-release\.mjs --dir "\$RUNNER_TEMP\/moneypal-release"\n/u);
  assert.doesNotMatch(workflow, /npm publish/u, "工作流不得直接发布；根包与两个发布包都只经 scripts/publish-release.mjs。");
  assert.doesNotMatch(workflow, /publish:dsh|publish:mcp/u, "发布必须复用已验收的 tgz，不重新构建。");
  assert.doesNotMatch(workflow, /NPM_TOKEN/u, "npm 发布必须走 OIDC，不读取 NPM_TOKEN。");
  assert.equal(count(workflow, /run: npm run build\n/gu), 1, "每个 job 只完整构建一次。");

  const install = workflow.indexOf("run: npm ci");
  const build = workflow.indexOf("run: npm run build");
  const runtime = workflow.indexOf("node dist/src/main.js setup-runtime");
  const gates = workflow.indexOf("npm run verify:release:built");
  const preflight = workflow.indexOf("npm run release:preflight");
  const publish = workflow.indexOf("publish-release.mjs");
  assert.ok(install >= 0 && build > install && runtime > build && gates > runtime && preflight > gates && publish > preflight, "顺序必须是 npm ci → build → setup-runtime → 验收 → 预检 → 发布。");

  // job 级 env 不允许使用 runner 上下文，否则整个工作流启动失败。
  const jobLevelRunnerEnv = workflow.split("\n").filter((line) => /^      [A-Z_]+: .*runner\./u.test(line));
  assert.deepEqual(jobLevelRunnerEnv, [], "runner 上下文只能出现在 step 级 env。");
});
