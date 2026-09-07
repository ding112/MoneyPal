import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// 在临时 DSH_HOME 下构造 DSH Web 的 standard 预设，供 CLI 与安装器测试共用。
export async function standardPreset(home: string, profile = "web", marker = "standard-plugin"): Promise<string> {
  const standard = join(home, "profiles", profile, "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets", "standard");
  await mkdir(standard, { recursive: true });
  await writeFile(join(standard, "preset.yml"), "name: 标准模式\n");
  await writeFile(join(standard, "agent.cordis.yml"), `- id: standard\n  name: ${marker}\n`);
  return standard;
}

// DSH 全局共享层级的 standard 预设（`profiles/node_modules/...`，无 Web profile 前缀）。
export async function sharedStandardPreset(home: string, marker: string): Promise<string> {
  const standard = join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets", "standard");
  await mkdir(standard, { recursive: true });
  await writeFile(join(standard, "preset.yml"), "name: 标准模式\n");
  await writeFile(join(standard, "agent.cordis.yml"), `- id: standard\n  name: ${marker}\n`);
  return standard;
}

export function managedPresetPath(home: string): string {
  return join(home, ".agent-presets", "dsh-moneypal");
}