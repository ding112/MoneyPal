import assert from "node:assert/strict";
import { access, readFile, realpath, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workspace = fileURLToPath(new URL("../..", import.meta.url));
const candidate = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u;

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

test("根版本与 lockfile、DSH 生成包始终一致", async () => {
  const packageJson = await readJson(`${workspace}/package.json`);
  const version = String(packageJson.version ?? "");
  assert.match(version, candidate, "根版本必须符合 X.Y.Z 或 X.Y.Z-rc.N 格式。");

  const lockfile = await readJson(`${workspace}/package-lock.json`);
  assert.equal(lockfile.version, version, "package-lock.json 顶层版本必须与根版本一致。");
  assert.equal(lockfile.packages?.[""]?.version, version, "package-lock.json 的 packages[\"\"] 版本必须与根版本一致。");

  const manifest = await readJson(`${workspace}/dist/packages/dsh-moneypal/package.json`);
  assert.equal(manifest.version, version, "dsh-moneypal 的生成包版本必须与根版本一致。");
  assert.deepEqual(await readdir(`${workspace}/dist/packages`), ["dsh-moneypal"]);
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

test("DSH 发布脚本默认把候选发到 next，绝不无标记覆盖 latest", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
  const command = packageJson.scripts?.["publish:dsh"] ?? "";
  assert.match(command, /npm publish/u);
  assert.match(command, /--tag next/u, "publish:dsh 必须显式使用 --tag next。");
  assert.doesNotMatch(command, /--tag latest/u);
});

test("发布包将公开 registry 与 next 固化为安全默认值", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../packages/dsh-moneypal/package.json", import.meta.url), "utf8")) as { publishConfig?: unknown };
  assert.deepEqual(manifest.publishConfig, {
    registry: "https://registry.npmjs.org/",
    access: "public",
    tag: "next",
  });
});

test("市场子包清单可发现且与根清单指向同一补丁", async () => {
  const rootManifestPath = resolve(workspace, "package.json");
  const subManifestPath = resolve(workspace, "packages", "dsh-moneypal", "package.json");
  const rootManifest = await readJson(rootManifestPath);
  const subManifest = await readJson(subManifestPath);

  assert.equal(subManifest.name, "dsh-moneypal", "市场目录探测器读取的子包清单必须声明包名 dsh-moneypal。");
  assert.match(String(subManifest.repository?.url ?? ""), /github\.com\/ding112\/MoneyPal/u, "子包 repository.url 必须指回 ding112/MoneyPal 仓库。");
  assert.deepEqual(subManifest.dsh?.bundle?.patch, ["./cordis.patch.yml", "./presets/moneypal.patch.yml"], "子包补丁必须按宿主补丁优先、预设声明随后顺序，并相对自身目录。");

  const rootPatches = rootManifest.dsh?.bundle?.patch as string[];
  const subPatches = subManifest.dsh?.bundle?.patch as string[];
  assert.deepEqual(rootPatches, ["./packages/dsh-moneypal/cordis.patch.yml", "./packages/dsh-moneypal/presets/moneypal.patch.yml"]);
  for (let index = 0; index < subPatches.length; index += 1) {
    const rootPatch = resolve(dirname(rootManifestPath), rootPatches[index]);
    const subPatch = resolve(dirname(subManifestPath), subPatches[index]);
    await access(rootPatch);
    assert.equal(await realpath(subPatch), await realpath(rootPatch), `根清单与子包清单第 ${index + 1} 个补丁必须指向同一文件。`);
  }
});
