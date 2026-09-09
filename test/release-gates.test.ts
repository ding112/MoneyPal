import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
  for (const path of ["dsh-moneypal", "mcp-moneypal"]) {
    const template = JSON.parse(await readFile(new URL(`../../packages/${path}/package.template.json`, import.meta.url), "utf8")) as { publishConfig?: unknown };
    assert.deepEqual(template.publishConfig, {
      registry: "https://registry.npmjs.org/",
      access: "public",
      tag: "next",
    });
  }
});

test("收录清单前置：根清单声明 dsh.bundle 且与 dsh 模板一致", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    dsh?: { bundle?: { patch?: unknown } };
  };
  assert.equal(packageJson.dsh?.bundle?.patch, "./cordis.patch.yml");

  const template = JSON.parse(
    await readFile(new URL("../../packages/dsh-moneypal/package.template.json", import.meta.url), "utf8"),
  ) as { dsh?: { bundle?: { patch?: unknown } } };
  assert.equal(template.dsh?.bundle?.patch, packageJson.dsh?.bundle?.patch);

  await access(new URL("../../cordis.patch.yml", import.meta.url));
});
