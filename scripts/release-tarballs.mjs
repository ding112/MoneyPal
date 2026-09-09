import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { exportTarballs, filesUnder, integrity } from "./release-utils.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const packages = ["dsh-moneypal", "mcp-moneypal"];
const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const expectedVersion = rootPackage.version;
const output = process.env.MONEYPAL_TARBALL_OUTPUT;
assert(typeof expectedVersion === "string" && expectedVersion.length > 0, "package.json 必须提供非空 version。");
const temporary = await mkdtemp(join(tmpdir(), "moneypal-tarballs-"));

try {
  const packed = await Promise.all(packages.map(pack));
  for (const item of packed) await audit(item);
  for (const item of packed) item.integrity = integrity(await readFile(item.tarball));
  if (output) await exportTarballs(packed, output);
  console.log(JSON.stringify({ ok: true, version: expectedVersion, output: output ?? null, packages: packed.map(({ name, tarball, files, integrity: sha512 }) => ({ name, tarball, files, integrity: sha512 })) }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function pack(name) {
  const directory = join(root, "dist", "packages", name);
  const { stdout } = await exec("npm", ["pack", "--json", "--pack-destination", temporary], { cwd: directory, env: npmEnvironment() });
  const [result] = JSON.parse(stdout);
  return { name, tarball: join(temporary, result.filename), files: result.files.map((file) => file.path) };
}

async function audit(item) {
  const required = item.name === "dsh-moneypal"
    ? ["README.md", "dist/src/finance/bridge.py", "dist/src/client.bundle.cjs"]
    : ["README.md", "dist/src/finance/bridge.py", "skills/mcp-moneypal/SKILL.md"];
  required.forEach((file) => assert(item.files.includes(file), `${item.name} tarball 缺少 ${file}。`));
  item.files.forEach((file) => assert(!/^(?:test|src)\//u.test(file) && (!file.endsWith(".ts") || file.endsWith(".d.ts")) && !file.endsWith(".map"), `${item.name} tarball 包含开发残留 ${file}。`));
  const install = join(temporary, `${item.name}-install`);
  await mkdir(install, { recursive: true });
  await run("npm", ["init", "--yes"], install);
  await run("npm", ["install", "--ignore-scripts", item.tarball], install);
  const packageDirectory = join(install, "node_modules", item.name);
  await access(join(packageDirectory, "package.json"));
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  assert(manifest.version === expectedVersion, `${item.name} 隔离安装的版本错误。`);
  await assertNoSourceMaps(packageDirectory, item.name);
  await run(process.execPath, [join(install, "node_modules", ".bin", item.name), "runtime-status"], install);
  await assertExportsLoadable(install, item.name, manifest.exports);
  if (item.name === "dsh-moneypal") {
    await access(join(install, "node_modules", item.name, "dist", "src", "client.bundle.cjs"));
    await run(process.execPath, ["--check", join(install, "node_modules", item.name, "dist", "src", "client.bundle.cjs")], install);
    await absent(join(install, "node_modules", item.name, "dist", "src", "mcp"));
  } else {
    await absent(join(install, "node_modules", item.name, "dist", "src", "dsh.js"));
    await absent(join(install, "node_modules", item.name, "dist", "src", "client.bundle.cjs"));
  }
}

async function assertNoSourceMaps(directory, name) {
  for (const file of await filesUnder(directory)) {
    assert(!file.endsWith(".map"), `${name} 的 tarball 包含 source map：${file}。`);
    if (!file.endsWith(".js") && !file.endsWith(".cjs")) continue;
    const source = await readFile(join(directory, file), "utf8");
    assert(!source.includes("sourceMappingURL="), `${name} 的 tarball 包含 source map 引用：${file}。`);
  }
}

async function assertExportsLoadable(install, name, exports) {
  assert(exports && typeof exports === "object", `${name} 缺少声明的 exports。`);
  for (const [key, value] of Object.entries(exports)) {
    const entry = typeof value === "string" ? value : value?.import ?? value?.default;
    const types = typeof value === "object" && value ? value.types : undefined;
    assert(typeof entry === "string", `${name} 的 ${key} 缺少可加载 ESM 入口。`);
    if (!entry.endsWith(".json")) {
      const prelude = entry.endsWith(".cjs") ? "globalThis.window={__ModuleLoader__:{load(){}}};" : "";
      await run(process.execPath, ["--input-type=module", "--eval", `${prelude}import(${JSON.stringify(`${name}${key === "." ? "" : key.slice(1)}`)})`], install);
    }
    else await stat(join(install, "node_modules", name, entry));
    if (typeof types === "string") await stat(join(install, "node_modules", name, types));
  }
}

async function absent(path) {
  try { await access(path); } catch { return; }
  throw new Error(`发布包不应包含 ${path}。`);
}

async function run(command, args, cwd = root) { await exec(command, args, { cwd, env: npmEnvironment() }); }
function npmEnvironment() { return { ...process.env, npm_config_cache: join(temporary, "npm-cache") }; }
function assert(condition, message) { if (!condition) throw new Error(message); }
