#!/usr/bin/env node

import { installPreset } from "./install-preset.js";
import { initializeLedger } from "./init-ledger.js";
import { inspectRuntime, setupRuntime } from "./finance/runtime.js";
import { parseSetupArguments } from "./cli.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "install-preset" && args.length === 0) {
    console.log(await installPreset());
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
  throw new Error("用法：dsh-moneypal <install-preset | init [账本工作区] | setup-runtime [--upgrade] | runtime-status>");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
