import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const integrity = (value) => `sha512-${createHash("sha512").update(value).digest("base64")}`;
export async function coreFiles(directory, root = directory) {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await coreFiles(path, root));
    else if (entry.isFile()) files[relative(root,path).replaceAll("\\", "/")] = sha256(await readFile(path));
    else throw new Error("核心目录不允许符号链接或特殊文件。");
  }
  return files;
}
export async function verifyCore(directory, expectedRecordHash) {
  const bytes = await readFile(join(directory, "CORE-SOURCE.json"));
  if (expectedRecordHash && sha256(bytes) !== expectedRecordHash) throw new Error("核心来源记录摘要不匹配。");
  const record = JSON.parse(bytes);
  if (record.schemaVersion !== 1 || record.name !== "moneypal-core" || typeof record.version !== "string" || record.version.length === 0 || !record.files) throw new Error("核心来源记录无效。");
  const files = await coreFiles(directory); delete files["CORE-SOURCE.json"];
  if (JSON.stringify(Object.entries(files).sort()) !== JSON.stringify(Object.entries(record.files).sort())) throw new Error("核心文件摘要不匹配。");
  return record;
}
