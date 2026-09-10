import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const workspacePackage = new URL("../../package.json", import.meta.url);
const releaseRoot = fileURLToPath(new URL("../packages/", import.meta.url));

test("根工作区不可发布，DSH 与 MCP 生成两个独立 npm 包", async () => {
  const root = JSON.parse(await readFile(workspacePackage, "utf8")) as { private?: boolean; scripts?: Record<string, string> };
  assert.equal(root.private, true);

  const dsh = await packageJson("dsh-moneypal");
  assert.equal(dsh.name, "dsh-moneypal");
  assert.deepEqual(dsh.bin, { "dsh-moneypal": "dist/src/main.js" });
  await present("dsh-moneypal/dist/src/dsh.js");
  await present("dsh-moneypal/dist/src/client.bundle.cjs");
  await absent("dsh-moneypal/dist/src/mcp");
  await absent("dsh-moneypal/dist/src/mcp-main.js");
  await absent("dsh-moneypal/skills");
  await present("dsh-moneypal/dist/src/finance/bridge.py");

  const mcp = await packageJson("mcp-moneypal");
  assert.equal(mcp.name, "mcp-moneypal");
  assert.deepEqual(mcp.bin, { "mcp-moneypal": "dist/src/mcp-main.js" });
  await present("mcp-moneypal/dist/src/mcp/server.js");
  await present("mcp-moneypal/skills/mcp-moneypal/SKILL.md");
  await present("mcp-moneypal/skills/mcp-moneypal/references/bootstrap.md");
  await absent("mcp-moneypal/dist/src/dsh.js");
  await absent("mcp-moneypal/dist/src/host.js");
  await absent("mcp-moneypal/dist/src/client.bundle.cjs");
  await absent("mcp-moneypal/cordis.patch.yml");
  await present("mcp-moneypal/dist/src/finance/bridge.py");
  assert.deepEqual(
    await readFile(`${releaseRoot}/dsh-moneypal/dist/src/finance/bridge.py`),
    await readFile(`${releaseRoot}/mcp-moneypal/dist/src/finance/bridge.py`),
  );
  for (const name of ["dsh-moneypal", "mcp-moneypal"]) await assertPublishedJavaScriptHasNoSourceMap(`${releaseRoot}/${name}/dist/src`);
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
  for (const name of ["dsh-moneypal", "mcp-moneypal"]) {
    const manifest = JSON.parse(await readFile(`${releaseRoot}/${name}/package.json`, "utf8")) as Record<string, unknown> & { scripts?: Record<string, string> };
    for (const field of dependencyFields) assert.equal(manifest[field], undefined, `${name} 不得声明 ${field}。`);
    for (const script of installScripts) assert.equal(manifest.scripts?.[script], undefined, `${name} 不得声明 ${script} 安装期脚本。`);
  }
});

async function packageJson(name: string): Promise<{ name?: string; bin?: Record<string, string> }> {
  return JSON.parse(await readFile(`${releaseRoot}/${name}/package.json`, "utf8")) as { name?: string; bin?: Record<string, string> };
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
