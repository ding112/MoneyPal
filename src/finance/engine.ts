import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { AccountQuery, DateRange, LedgerEngine, RegisterQuery } from "./types.js";
import { runtimeInvocation, type RuntimeInvocationOptions } from "./invocation.js";
import { FinanceError } from "./errors.js";
import { atLeastVersion, compareVersion, versionParts } from "./version.js";
import { acquireManagedRuntimeLease, type ManagedRuntimeLocks } from "./runtime.js";
import type { ValidationDiagnostic } from "./errors.js";

export interface LedgerEngineOptions extends RuntimeInvocationOptions { ledgerWorkspace: string; }
export interface BridgeProcessOptions { pythonExecutable: string; operationTimeoutMs: number; maxResultBytes: number; managedRuntimeLocks?: ManagedRuntimeLocks; }
type BridgeOperation = "validate" | "list_accounts" | "register" | "balance" | "income_statement" | "balance_sheet" | "preview" | "validate_candidates";
interface RuntimeVersions { python: string; beancount: string; beanquery: string; }
const MINIMUM_RUNTIME: RuntimeVersions = { python: "3.11", beancount: "3.2.3", beanquery: "0.2.0" };
const TESTED_RUNTIME: RuntimeVersions = { python: "3.14", beancount: "3.2.3", beanquery: "0.2.0" };
let warnedAboutUntestedRuntime = false;

/** 领域 facade：每次方法调用都只启动一个隔离 Python bridge。 */
export function createLedgerEngine(options: LedgerEngineOptions): LedgerEngine {
  const workspace = requireWorkspace(options.ledgerWorkspace);
  const processOptions = runtimeInvocation(options);
  const invoke = async <T>(operation: BridgeOperation, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    await assertMainLedger(workspace);
    return runBridge<T>(processOptions, operation, { ledgerDirectory: join(workspace, "default"), ...payload }, signal);
  };
  return {
    validateJournal: async (signal) => invoke("validate", {}, signal),
    listAccounts: async (signal) => invoke("list_accounts", {}, signal),
    queryRegister: (query: RegisterQuery = {}, signal) => invoke("register", { ...query }, signal),
    getBalance: (query: AccountQuery = {}, signal) => invoke("balance", { ...query }, signal),
    getIncomeStatement: (range: DateRange = {}, signal) => invoke("income_statement", { ...range }, signal),
    getBalanceSheet: (range: DateRange = {}, signal) => invoke("balance_sheet", { ...range }, signal),
  };
}

function requireWorkspace(value: string): string { if (typeof value !== "string" || !value.trim()) throw new FinanceError("invalid_workspace", "无法取得调用所属的账本工作区；请在账本会话中重试。"); return resolve(value); }
async function assertMainLedger(workspace: string): Promise<void> { try { await access(join(workspace, "default", "main.beancount")); } catch { throw new FinanceError("invalid_ledger_layout", "账本工作区必须包含 default/main.beancount；请先执行 init。"); } }

/** 生产 adapter 的内部进程 seam；不经包根导出。 */
export async function runBridge<T>(options: BridgeProcessOptions, operation: BridgeOperation, payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new FinanceError("cancelled", "账本操作已取消。");
  const release = options.managedRuntimeLocks ? await acquireManagedRuntimeLease(options.managedRuntimeLocks) : undefined;
  const bridge = fileURLToPath(new URL("./bridge.py", import.meta.url));
  const request = JSON.stringify({ protocolVersion: 1, operation, payload });
  try { return await new Promise<T>((resolvePromise, rejectPromise) => {
    const child = spawn(options.pythonExecutable, ["-I", "-X", "utf8", bridge], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let bytes = 0; let finished = false; let reason: FinanceError | undefined;
    const terminate = (error: FinanceError) => { if (reason) return; reason = error; child.kill("SIGKILL"); };
    const collect = (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > options.maxResultBytes) terminate(new FinanceError("result_too_large", "账本操作结果超过大小限制；请缩小查询范围后重试。")); };
    const abort = () => terminate(new FinanceError("cancelled", "账本操作已取消。"));
    const timer = setTimeout(() => terminate(new FinanceError("operation_timeout", "账本操作超时；请缩小查询范围后重试。")), options.operationTimeoutMs);
    timer.unref();
    const finish = (action: () => void) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); action(); };
    child.stdout.on("data", (chunk: Buffer) => { collect(chunk); stdout += chunk.toString("utf8"); });
    child.stderr.on("data", collect);
    child.on("error", () => finish(() => rejectPromise(new FinanceError("runtime_unavailable", "MoneyPal 运行时不可用；请执行 setup-runtime，或检查 MONEYPAL_PYTHON。"))));
    child.on("close", (code) => finish(() => {
      if (reason) return rejectPromise(reason);
      if (code !== 0) return rejectPromise(new FinanceError("internal_error", "账本操作未能完成；请检查账本和运行时后重试。"));
      try {
        const response: unknown = JSON.parse(stdout);
        if (!response || typeof response !== "object") throw new Error();
        const envelope = response as { protocolVersion?: unknown; runtime?: Partial<RuntimeVersions>; ok?: unknown; result?: T; error?: { code?: unknown; diagnostics?: unknown } };
        if (envelope.protocolVersion !== 1) throw new Error();
        if (!validRuntime(envelope.runtime)) throw new Error();
        verifyRuntime(envelope.runtime);
        if (envelope.ok === true) return resolvePromise(envelope.result as T);
        if (envelope.error?.code === "invalid_ledger_layout" || envelope.error?.code === "journal_invalid" || envelope.error?.code === "invalid_transaction_batch" || envelope.error?.code === "undeclared_account" || envelope.error?.code === "invalid_request") {
          return rejectPromise(new FinanceError(envelope.error.code, safeMessage(envelope.error.code), readDiagnostics(envelope.error.diagnostics)));
        }
        rejectPromise(new FinanceError("internal_error", "账本操作未能完成；请检查账本和运行时后重试。"));
      } catch (error) {
        rejectPromise(error instanceof FinanceError ? error : new FinanceError("internal_error", "账本操作未能完成；请检查账本和运行时后重试。"));
      }
    }));
    try { release?.recordChild(child.pid); } catch {
      terminate(new FinanceError("runtime_unavailable", "MoneyPal 运行时租约无法持久化；请稍后重试。"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    // 子进程可能在请求写入前就退出（缺少依赖、立即崩溃或已被终止）；写入失败由 close 事件统一决定结果，
    // 不能让 stdin 的 EPIPE 变成未捕获异常。
    child.stdin.on("error", () => { /* 结果由 close 事件决定 */ });
    child.stdin.end(request);
  }); } finally { await release?.release(); }
}

function validRuntime(value: Partial<RuntimeVersions> | undefined): value is RuntimeVersions {
  return typeof value?.python === "string" && typeof value.beancount === "string" && typeof value.beanquery === "string";
}

function verifyRuntime(runtime: RuntimeVersions): void {
  if (!atLeastVersion(runtime.python, MINIMUM_RUNTIME.python) || !atLeastVersion(runtime.beancount, MINIMUM_RUNTIME.beancount) || !atLeastVersion(runtime.beanquery, MINIMUM_RUNTIME.beanquery)) {
    throw new FinanceError("runtime_unavailable", "MoneyPal 运行时版本低于最低要求；请执行 setup-runtime。");
  }
  if (!warnedAboutUntestedRuntime && (aboveTestedPython(runtime.python) || compareVersion(runtime.beancount, TESTED_RUNTIME.beancount) > 0 || compareVersion(runtime.beanquery, TESTED_RUNTIME.beanquery) > 0)) {
    warnedAboutUntestedRuntime = true;
    process.emitWarning(`MoneyPal 检测到高于已验证范围的运行时：Python ${runtime.python}，Beancount ${runtime.beancount}，beanquery ${runtime.beanquery}。`);
  }
}

function aboveTestedPython(actual: string): boolean {
  const [major, minor] = versionParts(actual);
  const [testedMajor, testedMinor] = versionParts(TESTED_RUNTIME.python);
  return major > testedMajor || (major === testedMajor && minor > testedMinor);
}

function safeMessage(code: string): string { return ({ invalid_ledger_layout: "账本布局不符合 MoneyPal 的 Beancount 约束；请修复后重试。", journal_invalid: "正式账本未通过 Beancount 校验；请修复后重试。", invalid_transaction_batch: "候选交易批次未通过 Beancount 校验；请修复后重新预览。", undeclared_account: "候选交易使用了未声明账户；请先进行账本维护。", invalid_request: "日期参数不是合法的 YYYY-MM-DD 绝对日期。" } as Record<string, string>)[code]!; }

function readDiagnostics(value: unknown): ValidationDiagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics = value.filter((item): item is ValidationDiagnostic => {
    if (!item || typeof item !== "object") return false;
    const diagnostic = item as Partial<ValidationDiagnostic>;
    return diagnostic.severity === "error"
      && typeof diagnostic.message === "string"
      && typeof diagnostic.action === "string"
      && Boolean(diagnostic.location)
      && (diagnostic.location!.file === null || typeof diagnostic.location!.file === "string")
      && (diagnostic.location!.line === null || (Number.isInteger(diagnostic.location!.line) && diagnostic.location!.line > 0));
  });
  return diagnostics.length ? diagnostics : undefined;
}
