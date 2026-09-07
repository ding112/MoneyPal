// 稳定版提升门禁：先对 registry 上已发布的稳定版本做复验，通过后才允许把 latest 提升到该版本。
// 默认只输出待执行的 dist-tag 命令（dry-run）；显式传入 --apply 才真正修改 latest。
// 任何复验失败都以非零状态停止，绝不修改 latest。RC 版本（含 "-rc."）禁止进入本流程。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assert, filesUnder, forbidden, hash } from "./release-utils.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const packages = ["dsh-moneypal", "mcp-moneypal"];
const allowedExports = { "dsh-moneypal": new Set([".", "./dsh", "./client", "./package.json"]), "mcp-moneypal": new Set([".", "./package.json"]) };
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unknown = args.filter((arg) => arg !== "--apply");
if (unknown.length) throw new Error(`未知参数：${unknown.join(" ")}；仅支持 --apply。`);

const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert(!rootPackage.version.includes("-rc."), `提升只允许稳定版本，当前为 ${rootPackage.version}。`);

const temporary = await mkdtemp(join(tmpdir(), "moneypal-promote-"));
const npmEnv = { ...process.env, npm_config_cache: join(temporary, "npm-cache") };
try {
  const results = [];
  for (const name of packages) {
    const manifest = await view(name);
    assert(String(manifest.version) === rootPackage.version, `${name} 的 registry 版本应为 ${rootPackage.version}，实际为 ${manifest.version}。`);

    const tarball = await pack(name);
    const extracted = join(temporary, `${name}-contents`);
    await mkdir(extracted, { recursive: true });
    await exec("tar", ["-xzf", tarball, "-C", extracted], { env: npmEnv });
    const files = await filesUnder(extracted);
    assert(files.includes("package/package.json"), `${name} 的 registry tarball 缺少 package.json。`);
    assert(files.includes("package/dist/src/finance/bridge.py"), `${name} 的 registry tarball 缺少 canonical bridge。`);
    const published = JSON.parse(await readFile(join(extracted, "package", "package.json"), "utf8"));
    Object.keys(published.exports ?? {}).forEach((key) => assert(allowedExports[name].has(key), `${name} 的 registry 包导出了不受支持的入口 ${key}。`));
    for (const file of files) {
      if (!/\.(?:js|mjs|cjs|py|md|json|ya?ml)$/u.test(file)) continue;
      const content = await readFile(join(extracted, file), "utf8");
      forbidden.forEach((term) => assert(!content.includes(term), `${name} 的 registry 包 ${file} 包含遗留命名 ${term}。`));
    }
    results.push({
      name,
      version: String(manifest.version),
      currentLatest: manifest["dist-tags"]?.latest ?? null,
      sha256: hash(await readFile(join(extracted, "package", "dist", "src", "finance", "bridge.py"), "utf8")),
    });
  }
  assert(results[0].sha256 === results[1].sha256, "两个发布包的 registry canonical bridge 不一致。");
  assert(results[0].sha256 === (await localBridgeHash()), "registry 稳定包与本地构建的 canonical bridge 不一致；请确认稳定发布与已验证 RC 来源一致。");

  const commands = packages.map((name) => `npm dist-tag add ${name}@${rootPackage.version} latest`);
  console.log(JSON.stringify({ ok: true, version: rootPackage.version, packages: results, action: apply ? "applied" : "dry-run", ...(apply ? {} : { next: commands }) }, null, 2));
  if (apply) {
    for (const name of packages) await exec("npm", ["dist-tag", "add", `${name}@${rootPackage.version}`, "latest"], { env: npmEnv });
    const after = await Promise.all(packages.map(view));
    after.forEach(({ name, manifest }) => assert(manifest["dist-tags"]?.latest === rootPackage.version, `${name} 的 latest 未生效，实际为 ${manifest["dist-tags"]?.latest}。`));
    console.log(JSON.stringify({ ok: true, action: "applied", verified: after.map(({ name, manifest }) => ({ name, latest: manifest["dist-tags"].latest })) }, null, 2));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function view(name) {
  const { stdout } = await exec("npm", ["view", `${name}@${rootPackage.version}`, "version", "dist-tags", "--json"], { env: npmEnv });
  return { name, manifest: JSON.parse(stdout) };
}
async function pack(name) {
  const { stdout } = await exec("npm", ["pack", `${name}@${rootPackage.version}`, "--json", "--pack-destination", temporary], { env: npmEnv });
  const [result] = JSON.parse(stdout);
  assert(result && result.filename, `${name} 无法从 registry 打包 ${rootPackage.version}。`);
  return join(temporary, result.filename);
}
async function localBridgeHash() {
  return hash(await readFile(join(root, "dist", "packages", "dsh-moneypal", "dist", "src", "finance", "bridge.py"), "utf8"));
}
