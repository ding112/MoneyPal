import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { deepStrictEqual } from "node:assert/strict";
import { assert, filesUnder, forbidden, hash, json, releaseVersionPattern } from "./release-utils.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const packages = ["dsh-moneypal", "mcp-moneypal"];

async function main() {
  const rootPackage = await json(join(root, "package.json"));
  const expectedVersion = rootPackage.version;
  assert(typeof expectedVersion === "string" && expectedVersion.length > 0, "package.json 必须提供非空 version。");
  assert(releaseVersionPattern.test(expectedVersion), `根版本必须符合 X.Y.Z 或带编号的 X.Y.Z-alpha.N、X.Y.Z-beta.N、X.Y.Z-rc.N，当前为 ${expectedVersion}。`);
  const lockfile = await json(join(root, "package-lock.json"));
  assert(lockfile.version === expectedVersion && lockfile.packages?.[""]?.version === expectedVersion, "package-lock.json 的候选版本不一致。");
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: root });
  assert(!stdout.trim(), "发布门禁要求工作树干净；请先提交、暂存外部改动或在独立 checkout 中运行。");

  const release = await Promise.all(packages.map((name) => json(join(root, "dist", "packages", name, "package.json"))));
  release.forEach((manifest, index) => assert(manifest.version === expectedVersion, `${packages[index]} 的生成包版本不一致；请先 npm run build。`));
  const bridges = await Promise.all(packages.map((name) => readFile(join(root, "dist", "packages", name, "dist", "src", "finance", "bridge.py"))));
  assert(hash(bridges[0]) === hash(bridges[1]), "两个发布包的 canonical bridge 不一致。");

  const files = ["README.md", ...(await Promise.all(["packages", "skills", "scripts", "src", "dist/packages"].map((directory) => filesUnder(join(root, directory), root)))).flat()]
    .filter((file) => file !== "scripts/release-utils.mjs")
    .filter((file) => /\.(?:js|mjs|cjs|py|md|json|ya?ml)$/u.test(file));
  for (const file of files) {
    const content = await readFile(join(root, file), "utf8");
    forbidden.forEach((term) => assert(!content.includes(term), `${file} 包含遗留命名 ${term}。`));
  }
  const allowedExports = new Set([".", "./dsh", "./client", "./package.json"]);
  for (const manifest of release) Object.keys(manifest.exports ?? {}).forEach((key) => assert(allowedExports.has(key), `发布包导出了不受支持的入口 ${key}。`));
  const [dshManifest] = release;
  assert(dshManifest.exports["."], "dsh-moneypal 缺少包根导出。");
  assert(dshManifest.exports["./client"], "dsh-moneypal 缺少 ./client 客户端导出。");
  assert(dshManifest.dsh?.client, "dsh-moneypal 缺少 dsh.client 客户端发现配置。");
  assert(dshManifest.dsh?.bundle?.patch, "dsh-moneypal 缺少 dsh.bundle.patch 配置。");
  const rootEntry = await import(pathToFileURL(join(root, "dist", "packages", "dsh-moneypal", "dist", "src", "index.js")).href);
  assert(typeof rootEntry.apply === "function", "dsh-moneypal 包根必须导出可调用的 apply（Cordis 宿主装配入口）。");
  deepStrictEqual(rootEntry.inject, ["sessions", "connection"], "dsh-moneypal 包根必须声明宿主服务注入 inject。");
  assert(rootEntry.name === "dsh-moneypal", "dsh-moneypal 包根导出的 name 必须严格等于包名。");
  const patch = await readFile(join(root, "dist", "packages", "dsh-moneypal", "cordis.patch.yml"), "utf8");
  assert(/- id: connection\n  inject:\n    - webRuntime\n    - webServer(?:\n|$)/u.test(patch), "bundle patch 必须为 connection 声明其 RPC 注册所需的 webServer 注入。");
  assert(/- id: dsh-moneypal\n      name: dsh-moneypal(?:\n|$)/u.test(patch), "bundle patch 必须以精确包根挂载 dsh-moneypal。");
  assert(!/name:\s*dsh-moneypal\//u.test(patch), "bundle patch 不得使用包名子路径。");
  console.log(JSON.stringify({ ok: true, version: expectedVersion, packages, bridgeSha256: hash(bridges[0]) }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
