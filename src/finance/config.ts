import { isAbsolute, resolve } from "node:path";
import { FinanceError } from "./errors.js";

export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_BATCH_TTL_MS = 30 * 60 * 1000;


export function positiveInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new FinanceError("invalid_configuration", `${name} 必须是正整数。`);
  }
  return parsed;
}

export function selectedPython(explicit?: string): string | undefined {
  const value = explicit ?? process.env.MONEYPAL_PYTHON;
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !isAbsolute(value) || value !== resolve(value)) {
    throw new FinanceError("invalid_configuration", "MONEYPAL_PYTHON 必须是解释器的绝对路径。");
  }
  return value;
}
