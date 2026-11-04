// 完整构建只在输入和产物均未改变时复用；build:base 仍始终清空并重建。
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const stateFile = join(workspace, "dist", ".build-state.json");
const inputPaths = [
  "src", "test", "packages", "scripts", "package.json", "package-lock.json", "core-source.json", "tsconfig.json",
  "node_modules/typescript/package.json", "node_modules/@types/node/package.json",
];
// 缓存命中前也校验公共输入，不能复用被篡改的已安装核心。
run(["scripts/stage-core.mjs"]);
const inputs = await fingerprint(inputPaths);
let previous;
try { previous = JSON.parse(await readFile(stateFile, "utf8")); } catch (error) {
  if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
}
if (previous?.inputs === inputs && previous.outputs === await fingerprint(["dist"])) {
  console.log("构建输入和产物均未改变，复用 dist。");
} else {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("请通过 npm run build 调用完整构建。");
  run([npm, "run", "build:base"]);
  run(["scripts/build-release-packages.mjs"]);
  // 构建期间输入有变化时，不保存可复用状态。
  if (inputs === await fingerprint(inputPaths)) {
    await writeFile(stateFile, `${JSON.stringify({ inputs, outputs: await fingerprint(["dist"]) })}\n`);
  }
}

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: workspace, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`构建被信号 ${result.signal} 终止。`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function fingerprint(paths) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([process.version, process.platform, process.arch]));
  for (const path of paths) await add(path);
  return hash.digest("hex");

  async function add(relative) {
    const absolute = join(workspace, relative);
    if (absolute === stateFile) return;
    let info;
    try { info = await stat(absolute); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update(JSON.stringify([relative, "missing"]));
      return;
    }
    hash.update(JSON.stringify([relative, info.mode]));
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await add(join(relative, name));
    } else {
      const content = await readFile(absolute);
      hash.update(JSON.stringify(content.length));
      hash.update(content);
    }
  }
}
