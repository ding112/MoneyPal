import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { stampSkillVersion } from "./stamp-skill-version.mjs";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("..", import.meta.url));
const source = join(workspace, "experts", "moneypal");
const output = join(workspace, "dist", "experts");
const staging = join(output, ".moneypal-staging");
const workspacePackage = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));

// WorkBuddy：ZIP 顶层为单一 moneypal/ 目录。
const workbuddyArchive = join(output, "moneypal.zip");
await rm(staging, { recursive: true, force: true });
await rm(workbuddyArchive, { force: true });
await mkdir(join(staging, "moneypal"), { recursive: true });
await cp(source, join(staging, "moneypal"), { recursive: true });
await cp(join(workspace, "skills", "mcp-moneypal"), join(staging, "moneypal", "skills", "mcp-moneypal"), { recursive: true });
await stampSkillVersion(join(staging, "moneypal", "skills", "mcp-moneypal"), workspacePackage.version);
await rm(join(staging, "moneypal", ".qoder-plugin"), { recursive: true, force: true });
await exec("zip", ["-q", "-r", workbuddyArchive, "moneypal", "-x", "*.DS_Store"], { cwd: staging });

// Qoder：ZIP 根目录即插件根，文件名为 {name}-{version}.zip。
const qoderManifest = JSON.parse(await readFile(join(source, ".qoder-plugin", "plugin.json"), "utf8"));
const qoderArchive = join(output, `${qoderManifest.name}-${qoderManifest.version}.zip`);
await rm(staging, { recursive: true, force: true });
await rm(qoderArchive, { force: true });
await mkdir(staging, { recursive: true });
for (const entry of [".qoder-plugin", "agents", "README.md", "CONNECTORS.md", ".mcp.json"]) {
  await cp(join(source, entry), join(staging, entry), { recursive: true });
}
await cp(join(workspace, "skills", "mcp-moneypal"), join(staging, "skills", "mcp-moneypal"), { recursive: true });
await stampSkillVersion(join(staging, "skills", "mcp-moneypal"), workspacePackage.version);
await exec("zip", ["-q", "-r", qoderArchive, ".qoder-plugin", "agents", "skills", "README.md", "CONNECTORS.md", ".mcp.json", "-x", "*.DS_Store"], { cwd: staging });
await rm(staging, { recursive: true, force: true });
