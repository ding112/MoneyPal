import assert from "node:assert/strict";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const workspace = fileURLToPath(new URL("../..", import.meta.url));
const { releaseVersionPattern, releaseTagPattern, mainBoundVersionPattern } = (await import(
  pathToFileURL(join(workspace, "scripts", "release-utils.mjs")).href
)) as {
  releaseVersionPattern: RegExp;
  releaseTagPattern: RegExp;
  mainBoundVersionPattern: RegExp;
};

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

test("根版本与 lockfile、两个生成包始终一致", async () => {
  const packageJson = await readJson(`${workspace}/package.json`);
  const version = String(packageJson.version ?? "");
  assert.match(version, releaseVersionPattern, "根版本必须符合 X.Y.Z 或带编号的 X.Y.Z-alpha.N、X.Y.Z-beta.N、X.Y.Z-rc.N 格式。");

  const lockfile = await readJson(`${workspace}/package-lock.json`);
  assert.equal(lockfile.version, version, "package-lock.json 顶层版本必须与根版本一致。");
  assert.equal(lockfile.packages?.[""]?.version, version, "package-lock.json 的 packages[\"\"] 版本必须与根版本一致。");

  for (const name of ["dsh-moneypal", "mcp-moneypal"]) {
    const manifest = await readJson(`${workspace}/dist/packages/${name}/package.json`);
    assert.equal(manifest.version, version, `${name} 的生成包版本必须与根版本一致。`);
  }
});

test("发布版本格式只接受稳定版与必须带编号的 alpha、beta、rc", () => {
  for (const version of ["1.0.0", "1.0.0-alpha.1", "1.0.0-beta.12", "1.0.0-rc.3"]) {
    assert.match(version, releaseVersionPattern, `${version} 应被接受。`);
    assert.match(`v${version}`, releaseTagPattern, `v${version} 应被接受。`);
  }
  for (const version of ["1.0.0-alpha", "1.0.0-beta", "1.0.0-rc", "1.0.0-preview.1", "1.0.0-alpha.x", "1.0.0-alpha.1.2", "1.0", "1.0.0.0", "1.0.0+build.1", "1.0.0-ALPHA.1"]) {
    assert.doesNotMatch(version, releaseVersionPattern, `${version} 不应被接受。`);
  }
  for (const tag of ["1.0.0", "1.0.0-alpha.1", "v1.0.0-alpha", "v1.0.0-preview.1", "v1.0", "vv1.0.0"]) {
    assert.doesNotMatch(tag, releaseTagPattern, `${tag} 不应被接受。`);
  }
});

test("只有 rc 与稳定版要求提交位于 main 历史", () => {
  for (const version of ["1.0.0", "1.0.0-rc.1"]) assert.match(version, mainBoundVersionPattern, `${version} 必须检查 main 祖先。`);
  for (const version of ["1.0.0-alpha.1", "1.0.0-beta.7"]) assert.doesNotMatch(version, mainBoundVersionPattern, `${version} 不得要求 main 祖先。`);
});

test("发布验收链路只构建一次、保留真实打包且不含 dry-run", async () => {
  const packageJson = await readJson(`${workspace}/package.json`);
  const scripts = (packageJson.scripts ?? {}) as Record<string, string>;
  const built = scripts["verify:release:built"] ?? "";
  const release = scripts["test:release"] ?? "";

  assert.match(built, /run-release-tests\.mjs/u, "验收链路必须包含发布测试包装。");
  assert.match(built, /release:tarballs:built/u, "验收链路必须包含真实 tarball 打包与隔离安装。");
  assert.doesNotMatch(built, /npm run build/u, "verify:release:built 不构建，要求调用方已完成构建。");

  assert.match(release, /npm run build/u);
  assert.match(release, /npm run verify:release:built/u);
  assert.doesNotMatch(release, /pack:check/u, "dry-run 打包检查已移出正式验收链路。");
  assert.equal((release.match(/npm run build\b/gu) ?? []).length, 1, "正式验收链路只完整构建一次。");
  for (const name of ["pack:check", "pack:check:built"]) assert.ok(scripts[name], `${name} 必须保留供手工排查。`);
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
  // DSH 子包清单同时是市场目录的发现入口，因此用发布清单名；MCP 仍只有模板。
  const manifests = { "dsh-moneypal": "package.json", "mcp-moneypal": "package.template.json" };
  for (const [name, file] of Object.entries(manifests)) {
    const manifest = JSON.parse(await readFile(new URL(`../../packages/${name}/${file}`, import.meta.url), "utf8")) as { publishConfig?: unknown };
    assert.deepEqual(manifest.publishConfig, {
      registry: "https://registry.npmjs.org/",
      access: "public",
      tag: "next",
    });
  }
});

test("市场子包清单可发现且与根清单指向同一补丁", async () => {
  const rootManifestPath = resolve(workspace, "package.json");
  const subManifestPath = resolve(workspace, "packages", "dsh-moneypal", "package.json");
  const rootManifest = await readJson(rootManifestPath);
  const subManifest = await readJson(subManifestPath);

  assert.equal(subManifest.name, "dsh-moneypal", "市场目录探测器读取的子包清单必须声明包名 dsh-moneypal。");
  assert.match(String(subManifest.repository?.url ?? ""), /github\.com\/ding112\/MoneyPal/u, "子包 repository.url 必须指回 ding112/MoneyPal 仓库。");
  assert.equal(subManifest.dsh?.bundle?.patch, "./cordis.patch.yml", "子包补丁必须相对自身目录，发布包才能原样使用。");

  const rootPatch = resolve(dirname(rootManifestPath), String(rootManifest.dsh?.bundle?.patch ?? ""));
  const subPatch = resolve(dirname(subManifestPath), String(subManifest.dsh?.bundle?.patch ?? ""));
  await access(rootPatch);
  assert.equal(await realpath(subPatch), await realpath(rootPatch), "根清单与子包清单的补丁必须指向同一真实文件。");
});
