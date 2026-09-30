#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { initializeLedger } from "./init-ledger.js";
import { inspectRuntime, setupRuntime } from "./finance/runtime.js";
import { parseSetupArguments } from "./cli/runtime-arguments.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "install-preset" && args.length === 0) {
    await reportPresetRegistration();
    return;
  }
  if (command === "uninstall-preset" && args.length === 0) {
    console.log("MoneyPal 预设随 dsh-moneypal bundle 提供。请执行 dsh plugin --profile web remove dsh-moneypal 卸载。");
    return;
  }
  if (command === "init" && args.length <= 1) {
    console.log(`账本已初始化：${await initializeLedger({ ledgerWorkspace: args[0] })}`);
    return;
  }
  if (command === "setup-runtime") {
    const options = parseSetupArguments(args);
    console.log(JSON.stringify(await setupRuntime(options), null, 2));
    return;
  }
  if (command === "runtime-status" && args.length === 0) {
    console.log(JSON.stringify(await inspectRuntime(), null, 2));
    return;
  }
  throw new Error("用法：dsh-moneypal <install-preset | uninstall-preset | init [账本工作区] | setup-runtime [--upgrade] | runtime-status>");
}

async function reportPresetRegistration(): Promise<void> {
  const dshHome = resolve(process.env.DSH_HOME ?? join(homedir(), ".dsh"));
  const profilePackage = join(dshHome, "profiles", "web", "package.json");
  try {
    const manifest = JSON.parse(await readFile(profilePackage, "utf8")) as {
      dsh?: { profile?: { bundles?: unknown } };
    };
    const bundles = manifest.dsh?.profile?.bundles;
    if (Array.isArray(bundles) && bundles.includes("dsh-moneypal")) {
      console.log("MoneyPal 预设已随 dsh-moneypal bundle 注册。重启 DSH Web 后，在新会话中选择 MoneyPal。");
      return;
    }
  } catch {
    // Missing or unreadable profile means the bundle cannot be confirmed.
  }
  console.error("未在 DSH Web profile 中确认 dsh-moneypal bundle；请先运行 dsh plugin --profile web add dsh-moneypal。");
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
