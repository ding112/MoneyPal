import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const forbidden = ["HLEDGER_AGENT_", "hledger_unavailable", ".hledger-agent.lock"];

export function hash(value) { return createHash("sha256").update(value).digest("hex"); }
export function assert(condition, message) { if (!condition) throw new Error(message); }
export async function json(path) { return JSON.parse(await readFile(path, "utf8")); }

export async function filesUnder(directory, relativeTo = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path, relativeTo) : [relative(relativeTo, path)];
  }))).flat();
}
