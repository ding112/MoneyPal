// 双包发布：只复用已经通过验收的 tgz，先检查两个包的 registry 状态，再顺序发布到 npm next。
// 唯一命令接口：node scripts/publish-release.mjs --dir <tarball目录>
// 只使用 Node 内置模块，并通过 execFile 调用 npm；不读取 NPM_TOKEN，provenance 走 OIDC。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const registry = "https://registry.npmjs.org/";
export const releasePackages = ["dsh-moneypal", "mcp-moneypal"];
// registry 接受发布后，packument 对新版本仍可能滞后数秒；复验最多 6 次、间隔 5 秒（最长 30 秒）。
const verifyAttempts = 6;
const verifyDelayMs = 5000;

export function tarballIntegrity(value) { return `sha512-${createHash("sha512").update(value).digest("base64")}`; }

export async function publishRelease({
  directory,
  root = fileURLToPath(new URL("..", import.meta.url)),
  exec = promisify(execFile),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof directory !== "string" || directory.length === 0) throw new Error("必须提供 tarball 目录（--dir <目录>）。");
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = rootPackage.version;
  if (typeof version !== "string" || version.length === 0) throw new Error("根 package.json 必须提供非空 version。");

  const candidates = [];
  for (const name of releasePackages) {
    const file = join(directory, `${name}-${version}.tgz`);
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      throw new Error(`缺少已验收的 tarball：${file}。`);
    }
    candidates.push({ name, file, integrity: tarballIntegrity(bytes) });
  }

  // 先检查两个包，再决定是否发布任何内容。
  const checked = [];
  for (const item of candidates) {
    const state = await registryState(item, { exec, version });
    if (state.status === "exists" && state.integrity !== item.integrity) {
      throw new Error(`${item.name}@${version} 已存在于 registry，但 integrity 不一致（registry: ${state.integrity ?? "缺失"}，本地: ${item.integrity}）；不发布任何包。`);
    }
    checked.push({ ...item, status: state.status === "exists" ? "skipped" : "pending" });
  }

  const outcome = new Map();
  for (const item of checked) if (item.status === "skipped") outcome.set(item.name, { name: item.name, status: "skipped", integrity: item.integrity });
  const pending = checked.filter((item) => item.status === "pending");
  const published = [];
  for (const item of pending) {
    try {
      await exec("npm", ["publish", item.file, "--access", "public", "--tag", "next", "--provenance", "--registry", registry], {});
    } catch (error) {
      const remaining = pending.map(({ name }) => name).filter((name) => !published.includes(name));
      throw new Error(`发布 ${item.name}@${version} 失败：${describe(error)}；已发布 ${published.length ? published.join("、") : "无"}，仍待发布 ${remaining.join("、")}。双包发布不是原子操作：请用同一 tag 重试，已存在且字节一致的包会安全跳过。`);
    }
    outcome.set(item.name, { name: item.name, status: "published", integrity: await confirmIntegrity(item, { exec, sleep, version }) });
    published.push(item.name);
  }
  return { ok: true, version, registry, packages: releasePackages.map((name) => outcome.get(name)) };
}

async function registryState(item, { exec, version }) {
  let stdout;
  try {
    ({ stdout } = await exec("npm", ["view", `${item.name}@${version}`, "version", "dist", "--json", "--prefer-online", "--registry", registry], {}));
  } catch (error) {
    if (isNotFound(error)) return { status: "missing" };
    throw new Error(`查询 ${item.name}@${version} 失败：${describe(error)}。`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`解析 ${item.name}@${version} 的 registry 响应失败。`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`registry 返回的 ${item.name}@${version} 结构不可识别。`);
  if (String(parsed.version) !== version) throw new Error(`${item.name} 的 registry 版本 ${parsed.version ?? "缺失"} 与 ${version} 不一致。`);
  const value = parsed.dist?.integrity;
  return { status: "exists", integrity: typeof value === "string" && value.length > 0 ? value : null };
}

async function confirmIntegrity(item, { exec, sleep, version }) {
  let observed = "registry 暂未返回该版本";
  for (let attempt = 1; attempt <= verifyAttempts; attempt += 1) {
    if (attempt > 1) await sleep(verifyDelayMs);
    const state = await registryState(item, { exec, version });
    if (state.status === "exists") {
      if (state.integrity === item.integrity) return item.integrity;
      observed = `integrity 为 ${state.integrity ?? "缺失"}`;
    }
  }
  throw new Error(`${item.name}@${version} 发布后复验失败：${observed}（本地 ${item.integrity}）。`);
}

// 只有 npm 明确的 E404 才视为“该版本尚未发布”；网络、鉴权、限流与解析错误都必须失败。
function isNotFound(error) {
  const text = `${error?.stderr ?? ""}\n${error?.stdout ?? ""}\n${error?.message ?? ""}`;
  return /npm (?:error|ERR!) code E404\b/u.test(text);
}

function describe(error) {
  const text = String(error?.stderr ?? "").trim() || (error instanceof Error ? error.message : String(error));
  return text.split("\n").filter((line) => line.trim()).slice(-3).join(" / ") || "未知错误";
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.length !== 2 || args[0] !== "--dir" || !args[1]) throw new Error("用法：node scripts/publish-release.mjs --dir <tarball目录>");
  return publishRelease({ directory: args[1] });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
