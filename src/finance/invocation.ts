import { DEFAULT_MAX_RESULT_BYTES, DEFAULT_OPERATION_TIMEOUT_MS, positiveInteger, selectedPython } from "./config.js";
import { managedPython, managedRuntimeLocks, type ManagedRuntimeLocks } from "./runtime.js";

export interface RuntimeInvocationOptions {
  pythonExecutable?: string;
  operationTimeoutMs?: number;
  maxResultBytes?: number;
}

export function runtimeInvocation(options: RuntimeInvocationOptions): { pythonExecutable: string; operationTimeoutMs: number; maxResultBytes: number; managedRuntimeLocks?: ManagedRuntimeLocks } {
  const override = selectedPython(options.pythonExecutable);
  return {
    pythonExecutable: override ?? managedPython(),
    operationTimeoutMs: positiveInteger(options.operationTimeoutMs ?? process.env.MONEYPAL_OPERATION_TIMEOUT_MS, "MONEYPAL_OPERATION_TIMEOUT_MS", DEFAULT_OPERATION_TIMEOUT_MS),
    maxResultBytes: positiveInteger(options.maxResultBytes ?? process.env.MONEYPAL_MAX_RESULT_BYTES, "MONEYPAL_MAX_RESULT_BYTES", DEFAULT_MAX_RESULT_BYTES),
    ...(!override ? { managedRuntimeLocks: managedRuntimeLocks() } : {}),
  };
}
