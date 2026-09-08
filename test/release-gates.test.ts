import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

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
