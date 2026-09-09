import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRESET_ID = "dsh-moneypal";
const MANAGED_MARKER = "# dsh-moneypal-managed: true";

export interface InstallPresetOptions {
  dshHome?: string;
  packageName?: string;
}

export async function installPreset(options: InstallPresetOptions = {}): Promise<string> {
  const dshHome = resolve(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"));
  const packageName = options.packageName ?? await packageNameFromInstall();
  const standard = await findStandardPreset(dshHome);
  const target = join(dshHome, ".agent-presets", PRESET_ID);
  if (await exists(target)) {
    const composition = join(target, "agent.cordis.yml");
    const content = await safeRead(composition);
    if (!content.includes(MANAGED_MARKER)) {
      throw new Error(`预设 ${PRESET_ID} 已存在且不是本插件托管的预设；安装器不会覆盖它。请改名、删除该预设后重试，或选择其他预设。`);
    }
    await rm(target, { recursive: true, force: true });
  }

  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await cp(standard, target, { recursive: true, dereference: true, errorOnExist: true });
  const metadata = join(target, "preset.yml");
  await writeFile(metadata, managedMetadata(await readFile(metadata, "utf8")), "utf8");
  const composition = join(target, "agent.cordis.yml");
  await writeFile(composition, `${await readFile(composition, "utf8").then(withoutTrailingNewlines)}\n\n${MANAGED_MARKER}\n- id: dsh-moneypal-time-context\n  name: "@deepseek-ai/dsh-time-context"\n  config:\n    timeZone: Asia/Shanghai\n- id: dsh-moneypal-readonly\n  name: "${packageName}/dsh"\n`, "utf8");
  return target;
}

async function packageNameFromInstall(): Promise<string> {
  const packageFiles = [
    new URL(`../../packages/${PRESET_ID}/package.template.json`, import.meta.url),
    new URL("../../package.json", import.meta.url),
  ];
  const attempted: string[] = [];
  for (const packageFile of packageFiles) {
    attempted.push(fileURLToPath(packageFile));
    try {
      const content = await readFile(packageFile, "utf8");
      const parsed = JSON.parse(content) as { name?: unknown; private?: unknown };
      // 只接受已发布形态的插件清单：工作区根清单是 private 的，名称不是插件包名，
      // 即使模板缺失也不得把它的名字写进宿主预设（会引用不存在的 npm 包）。
      if (typeof parsed.name === "string" && parsed.name && parsed.private !== true) return parsed.name;
    } catch (error) {
      // 发布包不包含 monorepo 模板（ENOENT 属预期，继续下一个候选）；
      // 清单存在但损坏时直接失败，避免静默回退到错误名称。
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") continue;
      throw error;
    }
  }
  throw new Error(`未找到 DSH 插件包的有效 package name；已尝试：${attempted.join("、")}。`);
}

async function findStandardPreset(dshHome: string): Promise<string> {
  const candidates = [
    join(dshHome, "profiles", "web", "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets", "standard"),
    join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh", "config", "agent-presets", "standard"),
    join(dshHome, "profiles", "web", "node_modules", "@deepseek-ai", "dsh-agent-presets", "presets", "standard"),
    join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-agent-presets", "presets", "standard"),
    ...(await dshAgentPresetsCandidates()),
  ];
  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }
  throw new Error("未找到当前 DSH Web 的 standard 预设；请先运行 DSH Web，再执行 install-preset。");
}

async function dshAgentPresetsCandidates(): Promise<string[]> {
  const candidates: string[] = [];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const command of ["dsh", "dsh.cmd"]) {
      const executable = join(directory, command);
      try {
        const resolved = await realpath(executable);
        const dshRoot = dirname(dirname(resolved));
        candidates.push(join(dshRoot, "node_modules", "@deepseek-ai", "dsh-agent-presets", "presets", "standard"));
      } catch {
        // PATH 中的其他目录或平台入口可能没有 dsh，继续检查下一个候选。
      }
    }
  }
  return candidates;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function withoutTrailingNewlines(content: string): string {
  return content.replace(/\n*$/u, "");
}

function managedMetadata(content: string): string {
  const name = "name: MoneyPal";
  const description = "description: 基于当前账本工作区的 Beancount 财务工具。"
  const withName = /^name:.*$/mu.test(content)
    ? content.replace(/^name:.*$/mu, name)
    : `${name}\n${content}`;
  return /^description:.*$/mu.test(withName)
    ? withName.replace(/^description:.*$/mu, description)
    : `${withName.replace(/\n*$/u, "")}\n${description}\n`;
}
