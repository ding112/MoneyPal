import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const workspace = fileURLToPath(new URL("../..", import.meta.url));
const source = join(workspace, "experts", "moneypal");
const archive = join(workspace, "dist", "experts", "moneypal.zip");

test("恰恰账本专家包具备 WorkBuddy 必填市场字段", async () => {
  const manifest = JSON.parse(await readFile(join(source, ".codebuddy-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "moneypal");
  assert.equal(manifest.expertType, "agent");
  assert.equal(manifest.agentName, "moneypal");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
  assert.deepEqual(manifest.author, { name: "mengzai", email: "hz_dyl112@163.com" });
  assert.equal(manifest.displayName.zh, "恰恰账本");
  assert.equal(manifest.categoryId, "08-FinanceInvestment");
  assert.ok([...manifest.displayDescription.zh].length >= 40 && [...manifest.displayDescription.zh].length <= 50);
  assert.equal(manifest.tags.length, 3);
  assert.equal(manifest.quickPrompts.length, 3);
  assert.deepEqual(manifest.defaultInitPrompt, manifest.quickPrompts[0]);
  assert.deepEqual(manifest.agents, ["./agents/moneypal.md"]);
  assert.deepEqual(manifest.skills, ["./skills/mcp-moneypal"]);
});

test("专家 MCP 声明不携带账本路径、密钥或环境变量", async () => {
  const config = await readFile(join(source, ".mcp.json"), "utf8");
  assert.deepEqual(JSON.parse(config), { mcpServers: { moneypal: { command: "mcp-moneypal" } } });
  assert.doesNotMatch(config, /env|token|key|path|MONEYPAL_LEDGER_WORKSPACE/iu);
});

test("专家 ZIP 使用单一顶层目录并嵌入当前 MoneyPal 技能", async () => {
  await stat(archive);
  const { stdout } = await exec("unzip", ["-Z1", archive]);
  const files = stdout.trim().split("\n");
  assert(files.length > 0);
  assert(files.every((file) => file.startsWith("moneypal/")), "ZIP 必须只使用 moneypal 顶层目录。");
  for (const file of [
    "moneypal/.codebuddy-plugin/plugin.json",
    "moneypal/.mcp.json",
    "moneypal/agents/moneypal.md",
    "moneypal/avatars/expert.png",
    "moneypal/README.md",
    "moneypal/skills/mcp-moneypal/SKILL.md",
    "moneypal/skills/mcp-moneypal/references/bootstrap.md",
  ]) assert(files.includes(file), `ZIP 缺少 ${file}。`);
  assert(files.every((file) => !file.endsWith(".DS_Store")), "ZIP 不应包含 Finder 元数据。");

  const avatar = await stat(join(source, "avatars", "expert.png"));
  assert(avatar.size <= 500 * 1024, "头像必须不超过 500KB。");
  const image = await readFile(join(source, "avatars", "expert.png"));
  assert.equal(image.readUInt32BE(16), 512, "头像宽度必须为 512px。");
  assert.equal(image.readUInt32BE(20), 512, "头像高度必须为 512px。");
  const { stdout: packagedSkill } = await exec("unzip", ["-p", archive, "moneypal/skills/mcp-moneypal/SKILL.md"]);
  assert.equal(packagedSkill, await readFile(join(workspace, "skills", "mcp-moneypal", "SKILL.md"), "utf8"));
});
