import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const workspace = fileURLToPath(new URL("../..", import.meta.url));

test("发布门禁以 RC 版本、预检、tarball 验收和机器可读记录为公开入口", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: string;
    scripts?: Record<string, string>;
  };

  assert.equal(packageJson.version, "1.0.0-rc.2");
  const lockfile = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8")) as { version?: string; packages?: Record<string, { version?: string }> };
  assert.equal(lockfile.version, packageJson.version);
  assert.equal(lockfile.packages?.[""].version, packageJson.version);
  assert.equal(packageJson.scripts?.["release:preflight"], "node scripts/release-preflight.mjs");
  assert.equal(packageJson.scripts?.["test:fast"], "npm run build && npm run test:fast:built");
  assert.equal(packageJson.scripts?.["test:integration"], "npm run build && npm run test:integration:built");
  assert.equal(packageJson.scripts?.test, "npm run test:integration");
  assert.equal(packageJson.scripts?.["release:tarballs:built"], "node scripts/release-tarballs.mjs");
  assert.equal(packageJson.scripts?.["release:tarballs"], "npm run build && npm run release:tarballs:built");
  assert.equal(packageJson.scripts?.["test:release"], "npm run build && npm run test:integration:built && npm run pack:check:built && npm run release:tarballs:built");
  assert.equal(packageJson.scripts?.["release:acceptance"], "node scripts/release-acceptance.mjs");
  assert.equal(packageJson.scripts?.["release:promote"], "node scripts/release-promote.mjs");

  await access(new URL("../../scripts/release-preflight.mjs", import.meta.url));
  await access(new URL("../../scripts/release-tarballs.mjs", import.meta.url));
  await access(new URL("../../scripts/release-acceptance.mjs", import.meta.url));
  await access(new URL("../../scripts/release-promote.mjs", import.meta.url));
  await access(new URL("../../docs/releases/1.0.0-acceptance.md", import.meta.url));

  const guide = await readFile(`${workspace}/docs/releases/1.0.0-acceptance.md`, "utf8");
  assert.match(guide, /macOS arm64/u);
  assert.match(guide, /macOS x64/u);
  assert.match(guide, /Linux x64/u);
  assert.match(guide, /Windows x64/u);
  assert.match(guide, /Windows arm64/u);
  assert.match(guide, /next/u);
  assert.match(guide, /latest/u);
  assert.match(guide, /回退/u);
});

test("快速、集成与发布测试层复用已构建产物", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
  const fast = packageJson.scripts?.["test:fast:built"] ?? "";
  for (const file of ["balance-host", "batches", "beancount-only-contract", "init-ledger", "install-preset", "package-split", "register-contract", "release-gates", "statements-contract"]) {
    assert.match(fast, new RegExp(`dist/test/${file}\\.test\\.js`, "u"));
  }
  for (const file of ["mcp", "bridge-process", "write-interruption", "beancount-runtime", "write-runtime", "statements-runtime"]) {
    assert.doesNotMatch(fast, new RegExp(`dist/test/${file}\\.test\\.js`, "u"));
  }
  assert.equal(packageJson.scripts?.["test:integration:built"], "node --test dist/test/*.test.js");
  assert.equal(packageJson.scripts?.["pack:check:built"], "npm pack --dry-run ./dist/packages/dsh-moneypal && npm pack --dry-run ./dist/packages/mcp-moneypal");

  const tarballs = await readFile(`${workspace}/scripts/release-tarballs.mjs`, "utf8");
  assert.doesNotMatch(tarballs, /npm", \["run", "build"\]/u);
});

test("发布脚本默认把候选发到 next，绝不无标记覆盖 latest", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
  for (const script of ["publish:dsh", "publish:mcp"]) {
    const command = packageJson.scripts?.[script] ?? "";
    assert.match(command, /npm publish/u);
    assert.match(command, /--tag next/u, `${script} 必须显式使用 --tag next。`);
    assert.doesNotMatch(command, /--tag latest/u);
  }
});

test("发布包将公开 registry 与 next 固化为安全默认值", async () => {
  for (const path of ["dsh-moneypal", "mcp-moneypal"]) {
    const template = JSON.parse(await readFile(new URL(`../../packages/${path}/package.template.json`, import.meta.url), "utf8")) as { publishConfig?: unknown };
    assert.deepEqual(template.publishConfig, {
      registry: "https://registry.npmjs.org/",
      access: "public",
      tag: "next",
    });
  }
});

test("tarball 与验收脚本从根 package.json 推导版本", async () => {
  const tarballs = await readFile(`${workspace}/scripts/release-tarballs.mjs`, "utf8");
  const acceptance = await readFile(`${workspace}/scripts/release-acceptance.mjs`, "utf8");
  for (const script of [tarballs, acceptance]) {
    assert.match(script, /readFile\([^\n]*package\.json/u);
    assert.doesNotMatch(script, /1\.0\.0-rc\.2/u);
  }
});

test("发布预检从 package.json 推导版本并与稳定提升共用扫描工具", async () => {
  const preflight = await readFile(`${workspace}/scripts/release-preflight.mjs`, "utf8");
  const promote = await readFile(`${workspace}/scripts/release-promote.mjs`, "utf8");
  assert.doesNotMatch(preflight, /expectedVersion\s*=\s*["']1\.0\.0-rc\.1/u);
  assert.doesNotMatch(preflight + promote, /["']H["']\s*\+\s*["']LEDGER_AGENT_/u);
  for (const helper of ["assert", "filesUnder", "forbidden", "hash"]) {
    assert.match(preflight, new RegExp(`\\b${helper}\\b`, "u"));
    assert.match(promote, new RegExp(`\\b${helper}\\b`, "u"));
  }
});

test("发布预检阻止装配回归：包根无 apply、patch 使用子路径、客户端发现缺失", async () => {
  const preflight = await readFile(`${workspace}/scripts/release-preflight.mjs`, "utf8");
  assert.match(preflight, /typeof rootEntry\.apply === "function"/u);
  assert.match(preflight, /包根必须声明宿主服务注入 inject/u);
  assert.match(preflight, /name 必须严格等于包名/u);
  assert.match(preflight, /bundle patch 必须以精确包根挂载 dsh-moneypal/u);
  assert.match(preflight, /bundle patch 不得使用包名子路径/u);
  assert.match(preflight, /缺少 \.\/client 客户端导出/u);
  assert.match(preflight, /缺少 dsh\.client 客户端发现配置/u);
});

test("稳定版提升门禁拒绝 RC 版本且不会触碰 registry", async () => {
  await assert.rejects(
    execute(process.execPath, [new URL("../../scripts/release-promote.mjs", import.meta.url).pathname], { cwd: workspace }),
    (error: { code?: number; stderr?: string }) => error instanceof Error && error.code === 1 && /提升只允许稳定版本/u.test(String(error.stderr)),
  );
});

test("npm 工具链固定版本，插件开发规范与 AGENTS 指针存在", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { packageManager?: string };
  assert.equal(packageJson.packageManager, "npm@11.14.1");

  const spec = await readFile(`${workspace}/docs/agents/dsh-plugin-development.md`, "utf8");
  for (const heading of ["## 依赖边界", "## 服务访问", "## 注册语义", "## 工具契约", "## 错误边界", "## 验证流程"]) {
    assert.ok(spec.includes(heading), `插件开发规范缺少 ${heading} 章节。`);
  }
  assert.match(spec, /npm run test:fast/u);
  assert.match(spec, /npm test/u);
  assert.match(spec, /npm run test:release/u);
  assert.match(spec, /npm run release:preflight/u);

  const agents = await readFile(`${workspace}/AGENTS.md`, "utf8");
  assert.match(agents, /修改 DSH\/MCP 插件入口、服务注入、工具契约、宿主注册、运行时依赖或发布流程前，必须先读取 `docs\/agents\/dsh-plugin-development\.md`。/u);
});
