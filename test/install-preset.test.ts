import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentPresetsStandardPreset, managedPresetPath, sharedStandardPreset, standardPreset } from "./preset-fixtures.js";

type InstallPresetModule = typeof import("../src/install-preset.js");

let root: string;

async function installPreset(options: Parameters<InstallPresetModule["installPreset"]>[0]): Promise<string> {
  const module = await import(new URL("../packages/dsh-moneypal/dist/src/install-preset.js", import.meta.url).href) as InstallPresetModule;
  return module.installPreset(options);
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-moneypal-install-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("安装器从 standard 生成可刷新托管预设，并使用包实际名称", async () => {
  const home = join(root, "home");
  await standardPreset(home);

  await installPreset({ dshHome: home });
  await installPreset({ dshHome: home });

  const preset = await readFile(join(managedPresetPath(home), "agent.cordis.yml"), "utf8");
  assert.match(preset, /name: "dsh-moneypal\/dsh"/u);
  assert.doesNotMatch(preset, /name: "moneypal-workspace\/dsh"/u);
  assert.match(preset, /name: "@deepseek-ai\/dsh-time-context"/u);
  assert.match(preset, /timeZone: Asia\/Shanghai/u);
  assert.match(await readFile(join(managedPresetPath(home), "preset.yml"), "utf8"), /^name: MoneyPal$/mu);
});

test("安装器拒绝覆盖没有托管标记的同名预设", async () => {
  const home = join(root, "collision");
  await standardPreset(home);
  const target = managedPresetPath(home);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "agent.cordis.yml"), "- id: user\n  name: user-plugin\n");

  await assert.rejects(installPreset({ dshHome: home, packageName: "dsh-moneypal" }), /不会覆盖/u);
});

test("安装器优先使用当前 Web profile 的 standard 预设", async () => {
  const home = join(root, "web-first");
  await sharedStandardPreset(home, "shared-standard");
  await standardPreset(home, "web", "web-standard");

  await installPreset({ dshHome: home, packageName: "dsh-moneypal" });

  const preset = await readFile(join(home, ".agent-presets", "dsh-moneypal", "agent.cordis.yml"), "utf8");
  assert.match(preset, /name: web-standard/u);
  assert.doesNotMatch(preset, /name: shared-standard/u);
});

test("安装器兼容 dsh-agent-presets 提供的 standard 预设", async () => {
  const home = join(root, "agent-presets-layout");
  await agentPresetsStandardPreset(home);

  await installPreset({ dshHome: home, packageName: "dsh-moneypal" });

  const preset = await readFile(join(managedPresetPath(home), "agent.cordis.yml"), "utf8");
  assert.match(preset, /name: agent-presets-standard/u);
});
