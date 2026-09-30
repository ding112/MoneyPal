import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const compiledSource = join(workspace, "dist", "src");
const releaseRoot = join(workspace, "dist", "packages");
const workspacePackage = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));

await rm(releaseRoot, { recursive: true, force: true });
await buildDshPackage();

async function buildDshPackage() {
  const target = join(releaseRoot, "dsh-moneypal");
  await writePackageFiles("dsh-moneypal", target);
  await cp(compiledSource, join(target, "dist", "src"), { recursive: true });
  await copy(join(workspace, "src", "finance", "bridge.py"), join(target, "dist", "src", "finance", "bridge.py"));
  await copy(join(workspace, "packages", "dsh-moneypal", "cordis.patch.yml"), join(target, "cordis.patch.yml"));
  await copy(join(workspace, "packages", "dsh-moneypal", "presets", "moneypal.patch.yml"), join(target, "presets", "moneypal.patch.yml"));
  await sanitizePublishedJavaScript(join(target, "dist", "src"));
  await chmod(join(target, "dist", "src", "main.js"), 0o755);
}

async function writePackageFiles(name, target) {
  const source = join(workspace, "packages", name);
  // DSH 子包清单同时是市场目录的发现入口，必须是真实的 package.json。
  const manifestFile = "package.json";
  const manifest = JSON.parse(await readFile(join(source, manifestFile), "utf8"));
  await mkdir(target, { recursive: true });
  await Promise.all([
    writeFile(join(target, "package.json"), `${JSON.stringify({ ...manifest, version: workspacePackage.version }, null, 2)}\n`, "utf8"),
    copy(join(source, "README.md"), join(target, "README.md")),
  ]);
}

async function sanitizePublishedJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sanitizePublishedJavaScript(path);
    if (entry.name.endsWith(".map")) return rm(path);
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".cjs")) return undefined;
    const source = await readFile(path, "utf8");
    await writeFile(path, source.replace(/^\/\/# sourceMappingURL=.*\r?\n?/gmu, ""), "utf8");
    return undefined;
  }));
}

async function copy(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}
