import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";

const workspace = fileURLToPath(new URL("../..", import.meta.url));
const forbiddenRuntimeName = "h" + "ledger";
const forbiddenLedgerSuffix = ".journal";

test("活跃产品内容只保留 MoneyPal 与 Beancount 契约", async () => {
  const activeRoots = ["data", "docs/agents", "src", "scripts", "packages", "skills", "test", "dist/packages"];
  const files = (await Promise.all(activeRoots.map((root) => filesUnder(join(workspace, root))))).flat();
  files.push(join(workspace, "README.md"), join(workspace, "CONTEXT.md"));

  const matches = await Promise.all(files.filter((file) => !file.endsWith("scripts/release-utils.mjs")).map(async (file) => {
    const content = await readFile(file, "utf8");
    return content.toLowerCase().includes(forbiddenRuntimeName) || basename(file).endsWith(forbiddenLedgerSuffix) ? file : null;
  }));

  assert.deepEqual(matches.filter(Boolean), []);
  assert.deepEqual((await readdir(workspace)).filter((entry) => entry.endsWith(".tgz")), []);
});

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? filesUnder(path)
      : /\.(?:ts|js|mjs|cjs|py|md|json|ya?ml)$/u.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}
