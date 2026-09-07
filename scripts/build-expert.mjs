import { cp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("..", import.meta.url));
const source = join(workspace, "experts", "moneypal");
const output = join(workspace, "dist", "experts");
const staging = join(output, ".moneypal-staging");
const archive = join(output, "moneypal.zip");

await rm(staging, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(join(staging, "moneypal"), { recursive: true });
await cp(source, join(staging, "moneypal"), { recursive: true });
await cp(join(workspace, "skills", "mcp-moneypal"), join(staging, "moneypal", "skills", "mcp-moneypal"), { recursive: true });
await exec("zip", ["-q", "-r", archive, "moneypal", "-x", "*/.DS_Store"], { cwd: staging });
await rm(staging, { recursive: true, force: true });
