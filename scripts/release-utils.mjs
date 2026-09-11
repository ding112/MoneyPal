import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

export const forbidden = ["HLEDGER_AGENT_", "hledger_unavailable", ".hledger-agent.lock"];

// 发布版本格式的唯一来源：稳定版 X.Y.Z，或必须带编号的 alpha、beta、rc 预发布。
// alpha/beta 可从任意提交发布；rc 与稳定版仍要求提交位于 main 历史中。
export const releaseVersionPattern = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u;
export const releaseTagPattern = /^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/u;
export const mainBoundVersionPattern = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u;

export function hash(value) { return createHash("sha256").update(value).digest("hex"); }
export function integrity(value) { return `sha512-${createHash("sha512").update(value).digest("base64")}`; }
export function assert(condition, message) { if (!condition) throw new Error(message); }
export async function json(path) { return JSON.parse(await readFile(path, "utf8")); }

export async function filesUnder(directory, relativeTo = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path, relativeTo) : [relative(relativeTo, path)];
  }))).flat();
}

// 把已经通过验收的 tgz 按原文件名复制到指定目录；未通过验收的候选不会走到这里。
export async function exportTarballs(items, directory) {
  assert(typeof directory === "string" && directory.length > 0, "导出目录必须是非空路径。");
  await mkdir(directory, { recursive: true });
  return Promise.all(items.map(async (item) => {
    const target = join(directory, basename(item.tarball));
    await copyFile(item.tarball, target);
    return { ...item, exported: target };
  }));
}
