import type { SetupRuntimeOptions } from "./finance/runtime.js";

export function parseSetupArguments(args: string[]): SetupRuntimeOptions {
  const upgrade = args[0] === "--upgrade";
  const remaining = upgrade ? args.slice(1) : args;
  if (remaining.length === 0) return { upgrade };
  if (remaining.length === 2 && remaining[0] === "--python") return { upgrade, python: remaining[1] };
  throw new Error("setup-runtime 用法：setup-runtime [--upgrade] [--python <引导解释器>]。");
}
