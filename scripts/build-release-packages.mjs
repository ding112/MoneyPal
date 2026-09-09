import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const compiledSource = join(workspace, "dist", "src");
const releaseRoot = join(workspace, "dist", "packages");
const workspacePackage = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));

await rm(releaseRoot, { recursive: true, force: true });
await Promise.all([buildDshPackage(), buildMcpPackage()]);

async function buildDshPackage() {
  const target = join(releaseRoot, "dsh-moneypal");
  await writePackageFiles("dsh-moneypal", target);
  await cp(compiledSource, join(target, "dist", "src"), { recursive: true });
  await copy(join(workspace, "src", "finance", "bridge.py"), join(target, "dist", "src", "finance", "bridge.py"));
  await rm(join(target, "dist", "src", "mcp"), { recursive: true, force: true });
  await removeStem(join(target, "dist", "src"), "mcp-main");
  await copy(join(workspace, "cordis.patch.yml"), join(target, "cordis.patch.yml"));
  await sanitizePublishedJavaScript(join(target, "dist", "src"));
  await chmod(join(target, "dist", "src", "main.js"), 0o755);
}

async function buildMcpPackage() {
  const target = join(releaseRoot, "mcp-moneypal");
  await writePackageFiles("mcp-moneypal", target);
  await cp(join(compiledSource, "finance"), join(target, "dist", "src", "finance"), { recursive: true });
  await copy(join(workspace, "src", "finance", "bridge.py"), join(target, "dist", "src", "finance", "bridge.py"));
  await cp(join(compiledSource, "mcp"), join(target, "dist", "src", "mcp"), { recursive: true });
  await Promise.all([
    copyStem(compiledSource, join(target, "dist", "src"), "cli"),
    copyStem(compiledSource, join(target, "dist", "src"), "init-ledger"),
    copyStem(compiledSource, join(target, "dist", "src"), "mcp-main"),
    cp(join(workspace, "skills", "mcp-moneypal"), join(target, "skills", "mcp-moneypal"), { recursive: true }),
  ]);
  await sanitizePublishedJavaScript(join(target, "dist", "src"));
}

async function writePackageFiles(name, target) {
  const source = join(workspace, "packages", name);
  const template = JSON.parse(await readFile(join(source, "package.template.json"), "utf8"));
  await mkdir(target, { recursive: true });
  await Promise.all([
    writeFile(join(target, "package.json"), `${JSON.stringify({ ...template, version: workspacePackage.version }, null, 2)}\n`, "utf8"),
    copy(join(source, "README.md"), join(target, "README.md")),
  ]);
}

async function copyStem(source, target, stem) {
  await Promise.all([".js", ".js.map", ".d.ts"].map((extension) => copy(join(source, `${stem}${extension}`), join(target, `${stem}${extension}`))));
}

async function removeStem(directory, stem) {
  await Promise.all([".js", ".js.map", ".d.ts"].map((extension) => rm(join(directory, `${stem}${extension}`), { force: true })));
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
