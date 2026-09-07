import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const supported = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "win32-arm64"]);
const workspace = fileURLToPath(new URL("..", import.meta.url));
const rootPackage = JSON.parse(await readFile(resolve(workspace, "package.json"), "utf8"));
const packageVersion = rootPackage.version;
if (typeof packageVersion !== "string" || packageVersion.length === 0) throw new Error("package.json 必须提供非空 version。");
const target = process.env.MONEYPAL_RELEASE_PLATFORM ?? `${platform()}-${arch()}`;
const output = resolve(process.env.MONEYPAL_RELEASE_RESULT ?? `artifacts/releases/${packageVersion}/${target}.json`);
const result = {
  schemaVersion: 1,
  packageVersion,
  target,
  node: process.version,
  status: "blocked",
  stage: "environment",
  completed: [],
  pending: [
    "从 registry 的 next 标签安装两个 RC（不可用本地目录替代）。",
    "显式执行 setup-runtime，记录 Python、Beancount 与 beanquery 实际版本。",
    "以临时验收账本执行 init、validate、query、preview、人工确认后的 commit 与卸载哈希比对。",
    "完成 DSH Web 和 MCP 宿主人工验收，并把无敏感证据填入 docs/releases/1.0.0-acceptance.md。",
  ],
};

if (!supported.has(target)) result.pending.unshift(`目标 ${target} 不在五平台支持矩阵中。`);
if (!process.env.MONEYPAL_RELEASE_REGISTRY_READY) result.pending.unshift("未设置 MONEYPAL_RELEASE_REGISTRY_READY；为避免误将本地构建当作 registry 验收，流程已安全停止。");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.error(`发布验收未执行：${result.pending.join(" ")}\n机器可读结果：${output}`);
process.exitCode = 2;
