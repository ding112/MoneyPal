import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyCore } from "./core-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const candidate = JSON.parse(await readFile(join(root, "core-source.json"), "utf8"));
const name = "moneypal-core";
const locked = lock.packages[`node_modules/${name}`];
if (candidate.schemaVersion !== 1 || candidate.name !== name ||
    typeof candidate.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(candidate.version) ||
    candidate.filename !== `${name}-${candidate.version}.tgz` ||
    candidate.registry !== "https://registry.npmjs.org/" ||
    candidate.tarball !== `${candidate.registry}${name}/-/${candidate.filename}` ||
    !/^[a-f0-9]{64}$/u.test(candidate.sha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(candidate.sourceRecordSha256 ?? "") ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(candidate.integrity ?? "") ||
    !/^[a-f0-9]{40}$/u.test(candidate.sourceCommit ?? "") ||
    manifest.devDependencies?.[name] !== candidate.version ||
    lock.packages[""]?.devDependencies?.[name] !== candidate.version ||
    locked?.version !== candidate.version || locked?.resolved !== candidate.tarball) {
  throw new Error("公共核心输入引用或版本无效。");
}
if (locked.integrity !== candidate.integrity) throw new Error("核心来源与锁文件摘要不匹配。");
// npm ci 验证公开 tarball 的 integrity；此处独立绑定已安装文件，拒绝安装后的篡改。
const source = join(root, "node_modules", name);
const record = await verifyCore(source, candidate.sourceRecordSha256);
if (record.name !== candidate.name || record.version !== candidate.version || record.sourceCommit !== candidate.sourceCommit) {
  throw new Error("核心来源与候选不一致。");
}
const target = join(root, "src", "core");
await rm(target, { recursive: true, force: true });
await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });
await writeFile(join(root, "src", "core-provenance.json"), `${JSON.stringify({
  schemaVersion: 1, name: record.name, version: record.version, sourceCommit: record.sourceCommit,
  registry: candidate.registry, tarball: candidate.tarball, tarballSha256: candidate.sha256,
  integrity: candidate.integrity, sourceRecordSha256: candidate.sourceRecordSha256, files: record.files,
}, null, 2)}\n`);
await verifyCore(target, candidate.sourceRecordSha256);
console.log(`核心已准备：${record.name}@${record.version}`);
