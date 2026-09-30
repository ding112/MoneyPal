import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const workspacePackage = new URL("../../package.json", import.meta.url);
const releaseRoot = fileURLToPath(new URL("../packages/", import.meta.url));

test("根工作区不可发布且只生成 DSH npm 包", async () => {
  const root = JSON.parse(await readFile(workspacePackage, "utf8")) as { private?: boolean; scripts?: Record<string, string> };
  assert.equal(root.private, true);

  const dsh = await packageJson("dsh-moneypal");
  assert.equal(dsh.name, "dsh-moneypal");
  assert.deepEqual(dsh.bin, { "dsh-moneypal": "dist/src/main.js" });
  await present("dsh-moneypal/dist/src/dsh.js");
  await present("dsh-moneypal/dist/src/client.bundle.cjs");
  await absent("dsh-moneypal/dist/src/cli/finance.js");
  await present("dsh-moneypal/dist/src/cli/runtime-arguments.js");
  await absent("dsh-moneypal/skills");
  await present("dsh-moneypal/dist/src/finance/bridge.py");

  assert.deepEqual(await readdir(releaseRoot), ["dsh-moneypal"], "构建结果只包含 DSH 发布包。");
  await assertPublishedJavaScriptHasNoSourceMap(`${releaseRoot}/dsh-moneypal/dist/src`);
});

test("DSH 客户端可解析包元数据与客户端入口", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../packages/dsh-moneypal/package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; dsh: { client: unknown } };
  assert.equal(packageJson.exports["./package.json"], "./package.json");
  assert.ok(packageJson.exports["."]);
  assert.equal(packageJson.exports["./host"], undefined);
  assert.ok(packageJson.exports["./client"]);
  assert.ok(packageJson.dsh.client);
  const patch = await readFile(new URL("../packages/dsh-moneypal/cordis.patch.yml", import.meta.url), "utf8");
  assert.match(patch, /- id: connection\n  inject:\n    - webRuntime\n    - webServer(?:\n|$)/u, "connection 必须声明 RPC 注册实际使用的 webServer 服务。");
});

test("发布包包含 MoneyPal 预设补丁并按 bundle 顺序注册", async () => {
  const rootManifest = JSON.parse(await readFile(workspacePackage, "utf8")) as { dsh: { bundle: { patch: string[] } } };
  const subManifest = JSON.parse(await readFile(new URL("../packages/dsh-moneypal/package.json", import.meta.url), "utf8")) as { dsh: { bundle: { patch: string[] } }; files: string[] };
  const expectedRootPatches = ["./packages/dsh-moneypal/cordis.patch.yml", "./packages/dsh-moneypal/presets/moneypal.patch.yml"];
  const expectedSubPatches = ["./cordis.patch.yml", "./presets/moneypal.patch.yml"];
  assert.deepEqual(rootManifest.dsh.bundle.patch, expectedRootPatches);
  assert.deepEqual(subManifest.dsh.bundle.patch, expectedSubPatches);
  assert.ok(subManifest.files.includes("presets/moneypal.patch.yml"));

  const releaseManifest = await packageJson("dsh-moneypal") as { dsh?: { bundle?: { patch?: string[] } } };
  assert.deepEqual(releaseManifest.dsh?.bundle?.patch, expectedSubPatches);
  const patch = await readFile(`${releaseRoot}/dsh-moneypal/presets/moneypal.patch.yml`, "utf8");
  assert.match(patch, /id: preset-dsh-moneypal\n\s+name: '@deepseek-ai\/dsh-agent-preset'\n\s+config:\n\s+id: dsh-moneypal/u);
  assert.match(patch, /name: MoneyPal\n\s+description: MoneyPal 财务工具与完整 DSH 标准能力\n\s+order: 10/u);
  for (const id of ["persona", "agent-instructions", "tool-bash", "tool-pwsh", "tool-fs", "tool-fs-search", "tool-jobs", "skill-filesystem", "tool-skill", "command-goal", "tool-goal", "planning", "compaction", "delegation", "tool-ask-user", "tool-todo", "tool-web", "present", "tool-plugin-manager"]) {
    assert.match(patch, new RegExp(`- id: ${id}(?:\\n|$)`, "u"), `MoneyPal 预设缺少 standard 插件 ${id}。`);
  }
  assert.match(patch, /isolate:\n\s+planMode: true/u);
  assert.match(patch, /isolate:\n\s+compaction: true\n\s+toolResultPruner: true/u);
  assert.match(patch, /isolate:\n\s+workflowEngine: true/u);
  assert.match(patch, /disabled: !!js process\.platform === 'win32'/u);
  assert.match(patch, /disabled: !!js process\.platform !== 'win32'/u);
  assert.match(patch, /- id: dsh-moneypal-time-context\n\s+name: '@deepseek-ai\/dsh-time-context'\n\s+config:\n\s+timeZone: Asia\/Shanghai/u);
  assert.match(patch, /- id: dsh-moneypal-readonly\n\s+name: 'dsh-moneypal\/dsh'/u);
  assert.doesNotMatch(patch, /id: preset-standard\n/u);
});

test("发布包的根入口导出可调用的宿主装配契约", async () => {
  const entry = await import(pathToFileURL(join(releaseRoot, "dsh-moneypal", "dist", "src", "index.js")).href);
  assert.equal(typeof entry.apply, "function", "发布包根必须导出可调用的 apply。");
  assert.deepEqual(entry.inject, ["sessions", "connection"]);
  assert.equal(entry.name, "dsh-moneypal");
});

test("根工作区使用 npm，发布包清单不含依赖与安装期脚本", async () => {
  const root = JSON.parse(await readFile(workspacePackage, "utf8")) as { packageManager?: string };
  assert.match(root.packageManager ?? "", /^npm@/u, "根工作区必须使用 npm 作为 packageManager。");
  await rootAbsent("pnpm-lock.yaml");
  await rootAbsent("pnpm-workspace.yaml");

  const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"];
  const installScripts = ["preinstall", "install", "postinstall"];
  const manifest = JSON.parse(await readFile(`${releaseRoot}/dsh-moneypal/package.json`, "utf8")) as Record<string, unknown> & { scripts?: Record<string, string> };
  for (const field of dependencyFields) assert.equal(manifest[field], undefined, `dsh-moneypal 不得声明 ${field}。`);
  for (const script of installScripts) assert.equal(manifest.scripts?.[script], undefined, `dsh-moneypal 不得声明 ${script} 安装期脚本。`);
});

async function packageJson(name: string): Promise<{ name?: string; version?: string; bin?: Record<string, string>; dsh?: { bundle?: { patch?: string[] } } }> {
  return JSON.parse(await readFile(`${releaseRoot}/${name}/package.json`, "utf8")) as {
    name?: string;
    version?: string;
    bin?: Record<string, string>;
    dsh?: { bundle?: { patch?: string[] } };
  };
}

async function present(path: string): Promise<void> {
  await access(`${releaseRoot}/${path}`);
}

async function absent(path: string): Promise<void> {
  await assert.rejects(access(`${releaseRoot}/${path}`));
}

async function rootAbsent(path: string): Promise<void> {
  await assert.rejects(access(new URL(`../../${path}`, import.meta.url)));
}

async function assertPublishedJavaScriptHasNoSourceMap(directory: string): Promise<void> {
  for (const file of await filesUnder(directory)) {
    assert.equal(file.endsWith(".map"), false, `发布包不应包含 source map：${file}`);
    if (!file.endsWith(".js") && !file.endsWith(".cjs")) continue;
    assert.doesNotMatch(await readFile(`${directory}/${file}`, "utf8"), /sourceMappingURL=/u, `发布包不应保留 source map 引用：${file}`);
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? (await filesUnder(`${directory}/${entry.name}`)).map((file) => `${entry.name}/${file}`)
    : [entry.name]))).flat();
}
