import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION_TOKEN = "${MONEYPAL_VERSION}";

/** 将 skill 模板中的版本占位符替换为当前 MCP 发布版本。 */
export async function stampSkillVersion(skillDirectory, version) {
  const skillFile = join(skillDirectory, "SKILL.md");
  const content = await readFile(skillFile, "utf8");
  const occurrences = content.split(VERSION_TOKEN).length - 1;
  if (occurrences !== 1) {
    throw new Error(`技能版本占位符必须恰好出现一次：${skillFile}`);
  }
  await writeFile(skillFile, content.replace(VERSION_TOKEN, version), "utf8");
}
