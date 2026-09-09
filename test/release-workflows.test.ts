import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workspace = fileURLToPath(new URL("../..", import.meta.url));
const checkout = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const setupNode = "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38";
const releasePlease = "googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7";

const read = (path: string) => readFile(`${workspace}/.github/workflows/${path}`, "utf8");

test("Test 工作流只读、固定工具链、先检查 PR 标题再跑发布门禁", async () => {
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
  assert.match(workflow, /cancel-in-progress: true/u, "同一 ref 的旧任务应被取消。");
  assert.match(workflow, /run: npm ci/u);
  assert.match(workflow, /run: npm run test:release/u);

  assert.match(workflow, /if: github\.event_name == 'pull_request'/u, "PR 事件必须检查标题。");
  assert.match(workflow, /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/u);
  assert.match(workflow, /process\.env\.PR_TITLE/u);
  assert.doesNotMatch(workflow, /run: \|\n[^]*?\$\{\{ github\.event\.pull_request\.title \}\}/u, "标题只能经环境变量传入，不得插入 shell 命令。");
});

test("Release 工作流用 Release Please 驱动、OIDC 发布并保留手动 tag 重试", async () => {
  const workflow = await read("release.yml");

  assert.match(workflow, /push:\n    branches: \[main\]/u);
  assert.match(workflow, /workflow_dispatch:\n    inputs:\n      tag:\n[\s\S]*?required: true/u);
  assert.match(workflow, /concurrency:\n  group: release-main\n  cancel-in-progress: false/u);
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /node-version: 24/u);
  for (const permission of ["contents: write", "pull-requests: write", "issues: write", "id-token: write"]) {
    assert.match(workflow, new RegExp(`^  ${permission}$`, "mu"), `Release 工作流缺少 ${permission}。`);
  }
  assert.doesNotMatch(workflow, /^    environment:/mu, "本期不绑定 environment。");
  assert.ok(workflow.includes(checkout), "必须固定 actions/checkout v6。");
  assert.ok(workflow.includes(setupNode), "必须固定 actions/setup-node v6。");
  assert.ok(workflow.includes(releasePlease), "必须固定 release-please-action v5。");
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org\//u);
  assert.match(workflow, /package-manager-cache: false/u);
  assert.doesNotMatch(workflow, /^          cache: npm$/mu, "Release 工作流不启用依赖缓存。");
  assert.match(workflow, /config-file: release-please-config\.json/u);
  assert.match(workflow, /manifest-file: \.release-please-manifest\.json/u);
  assert.match(workflow, /target-branch: main/u);
  assert.doesNotMatch(workflow, /release-type:/u, "使用配置文件时不再传 release-type input。");
  assert.match(workflow, /RELEASE_CREATED: \$\{\{ steps\.release\.outputs\.release_created \}\}/u);
  assert.match(workflow, /if \[ "\$RELEASE_CREATED" != "true" \]/u, "release_created 必须按字符串比较。");
  assert.match(workflow, /steps\.release\.outputs\.sha/u, "checkout 必须使用 Release Please 输出的 sha。");
  assert.match(workflow, /gh workflow run release\.yml --ref \$tag -f tag=\$tag/u, "必须给出 tag 手动重试入口。");
  assert.match(workflow, /gh release view "\$tag"/u);
  assert.match(workflow, /git merge-base --is-ancestor/u);
  assert.ok(workflow.includes("1.0.0-rc.3"), "手动重试必须拒绝 rc.3 及更早版本。");
  assert.match(workflow, /MONEYPAL_TARBALL_OUTPUT/u, "发布必须复用门禁保留的 tgz。");
  assert.match(workflow, /run: npm run test:release/u);
  assert.match(workflow, /run: npm run release:preflight/u);
  assert.match(workflow, /setup-runtime/u, "发布门禁要求真实运行时，工作流必须先准备运行时。");
  assert.match(workflow, /node scripts\/publish-release\.mjs --dir "\$RUNNER_TEMP\/moneypal-release"/u);
  assert.doesNotMatch(workflow, /gh release create/u, "Release 由 Release Please 创建，不重复创建。");
  assert.doesNotMatch(workflow, /NPM_TOKEN/u, "npm 发布必须走 OIDC，不读取 NPM_TOKEN。");
  assert.doesNotMatch(workflow, /publish:dsh|publish:mcp/u, "发布必须复用已验收的 tgz，不重新构建。");
  assert.match(workflow, /GITHUB_STEP_SUMMARY/u, "必须在 Actions Summary 记录发布结果。");

  const gate = workflow.indexOf("npm run test:release");
  const preflight = workflow.indexOf("npm run release:preflight");
  const publish = workflow.indexOf("publish-release.mjs");
  assert.ok(gate >= 0 && preflight > gate && publish > preflight, "发布必须排在门禁与预检之后。");

  // job 级 env 不允许使用 runner 上下文，否则整个工作流启动失败。
  const jobLevelRunnerEnv = workflow.split("\n").filter((line) => /^      [A-Z_]+: .*runner\./u.test(line));
  assert.deepEqual(jobLevelRunnerEnv, [], "runner 上下文只能出现在 step 级 env。");
});
