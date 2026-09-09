import assert from "node:assert/strict";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workspace = fileURLToPath(new URL("../..", import.meta.url));
const candidate = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u;

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

test("根版本与 lockfile、两个生成包、Release Please manifest 始终一致", async () => {
  const packageJson = await readJson(`${workspace}/package.json`);
  const version = String(packageJson.version ?? "");
  assert.match(version, candidate, "根版本必须符合 X.Y.Z 或 X.Y.Z-rc.N 格式。");

  const lockfile = await readJson(`${workspace}/package-lock.json`);
  assert.equal(lockfile.version, version, "package-lock.json 顶层版本必须与根版本一致。");
  assert.equal(lockfile.packages?.[""]?.version, version, "package-lock.json 的 packages[\"\"] 版本必须与根版本一致。");

  for (const name of ["dsh-moneypal", "mcp-moneypal"]) {
    const manifest = await readJson(`${workspace}/dist/packages/${name}/package.json`);
    assert.equal(manifest.version, version, `${name} 的生成包版本必须与根版本一致。`);
  }

  const releasePlease = await readJson(`${workspace}/.release-please-manifest.json`);
  assert.equal(releasePlease["."], version, "Release Please manifest 的根组件版本必须与根版本一致。");
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
