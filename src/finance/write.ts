import { createHash } from "node:crypto";
import { link, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { runtimeInvocation, type RuntimeInvocationOptions } from "./invocation.js";
import { runBridge } from "./engine.js";
import { FinanceError } from "./errors.js";
import { readAbsoluteDate } from "./date.js";
import type {
  AmountSummary,
  DuplicateWarning,
  Transaction,
  TransactionCommit,
  TransactionPreview,
} from "./types.js";

export interface ConfirmedWriteOptions extends RuntimeInvocationOptions {
  ledgerWorkspace: string;
}

export interface ConfirmedTransactionWriter {
  preview(transactions: Transaction | Transaction[], signal?: AbortSignal): Promise<TransactionPreview>;
  commit(signal?: AbortSignal): Promise<TransactionCommit>;
}

interface PreparedBatch {
  targetFile: string;
  createsFile: boolean;
  transactions: string[];
  transactionText: string;
  amountSummary: AmountSummary[];
  duplicateWarnings: DuplicateWarning[];
  snapshot: LedgerSnapshot;
}

/** 快照由 TypeScript 写入 module 依据 Beancount 实际加载的完整 include 图计算。 */
interface LedgerSnapshot {
  files: Array<{ file: string; hash: string }>;
  targetExists: boolean;
}

interface PreviewBridgeResult {
  validation: "passed";
  transactions: string[];
  transactionText: string;
  amountSummary: AmountSummary[];
  duplicateWarnings: DuplicateWarning[];
  loadedFiles: string[];
}

/**
 * 基于 Beancount 的确认写入器：预览不持锁不落盘；提交持有跨进程账本锁，
 * 锁内重新校验并比对快照，先在目标目录同文件系统创建临时文件并同步，
 * 再以原子 replace（已有年度文件）或原子 no-clobber link（新年度文件）发布。
 * 一旦进入发布阶段就无法再报告安全取消；结果无法确认时返回
 * write_outcome_uncertain，保留 replacement 供人工诊断，禁止自动重试。
 */
export async function createConfirmedTransactionWriter(options: ConfirmedWriteOptions): Promise<ConfirmedTransactionWriter> {
  if (typeof options.ledgerWorkspace !== "string" || !options.ledgerWorkspace.trim()) {
    throw new FinanceError("invalid_workspace", "无法取得调用所属的账本工作区；请在 DSH Web 中打开账本工作区后重试。");
  }
  const ledgerDirectory = resolve(options.ledgerWorkspace, "default");
  const processOptions = runtimeInvocation(options);
  let prepared: PreparedBatch | undefined;

  const invoke = <T>(operation: "preview" | "validate_candidates", payload: Record<string, unknown>, signal?: AbortSignal): Promise<T> =>
    runBridge<T>(processOptions, operation, { ledgerDirectory, ...payload }, signal);

  return {
    async preview(input, signal) {
      const transactions = validateTransactions(input);
      try {
        const targetFile = `transactions/${transactions[0]!.date.slice(0, 4)}.beancount`;
        const result = await invoke<PreviewBridgeResult>("preview", { transactions }, signal);
        const createsFile = !(await exists(join(ledgerDirectory, targetFile)));
        prepared = {
          targetFile,
          createsFile,
          transactions: result.transactions,
          transactionText: result.transactionText,
          amountSummary: result.amountSummary,
          duplicateWarnings: result.duplicateWarnings,
          snapshot: await ledgerSnapshot(ledgerDirectory, result.loadedFiles, targetFile, signal),
        };
        return {
          targetFile,
          createsFile,
          transactions: result.transactions,
          transactionText: result.transactionText,
          validation: "passed",
          amountSummary: result.amountSummary,
          duplicateWarnings: result.duplicateWarnings,
        };
      } catch (error) {
        throw translatePreviewError(error);
      }
    },
    async commit(signal) {
      // 单次 commit 尝试开始时即消费批次；成功、失败、取消、过期后都必须重新预览并再次确认。
      const batch = prepared;
      prepared = undefined;
      if (!batch) throw new FinanceError("invalid_transaction_batch", "请先生成交易批次预览，再请求写入确认。");
      signal?.throwIfAborted();
      const lockPath = join(ledgerDirectory, ".moneypal-write.lock");
      let lock;
      try {
        lock = await acquireLedgerLock(lockPath);
      } catch (error) {
        throw translateError(error);
      }
      const targetPath = join(ledgerDirectory, batch.targetFile);
      const warnings: string[] = [];
      let replacement: string | undefined;
      let publishStarted = false;
      let keepLock = false;
      try {
        const current = await ledgerSnapshot(ledgerDirectory, batch.snapshot.files.map((entry) => join(ledgerDirectory, entry.file)), batch.targetFile, signal);
        if (!snapshotsEqual(batch.snapshot, current)) {
          throw new FinanceError("preview_stale", "预览后账本已变化；请重新生成预览并再次确认。");
        }
        const before = await readExisting(targetPath, batch.createsFile);
        const finalContent = appendText(before, batch.transactionText);
        const validated = await invoke<{ valid: true; loadedFiles: string[] }>("validate_candidates", { transactionText: batch.transactionText }, signal);
        if (!(await sameLoadSet(batch.snapshot.files, validated.loadedFiles, ledgerDirectory))) {
          throw new FinanceError("preview_stale", "预览后账本 include 集合已变化；请重新生成预览并再次确认。");
        }
        signal?.throwIfAborted();
        const mode = batch.createsFile ? 0o600 : (await stat(targetPath)).mode;
        replacement = join(dirname(targetPath), `.moneypal-write-${process.pid}-${Date.now()}.tmp`);
        await writeReplacement(replacement, finalContent, mode);
        publishStarted = true;
        if (injectedFault("RENAME")) throw new Error("publish fault");
        if (batch.createsFile) {
          await linkReplacement(replacement, targetPath);
          try {
            await rm(replacement, { force: true });
          } catch {
            warnings.push("发布后的临时文件清理失败；请通过账本维护检查并清理。");
          }
        } else {
          await rename(replacement, targetPath);
        }
        replacement = undefined;
        await syncDirectory(dirname(targetPath));
        // 发布已明确成功：此后仅临时文件或锁清理失败不影响正式内容，仍返回成功并记录净化后的警告。
        try {
          await lock.close();
          if (injectedFault("LOCK_CLEANUP")) throw new Error("lock cleanup fault");
          await rm(lockPath, { force: true });
        } catch {
          keepLock = true;
          warnings.push("账本锁清理失败；请通过账本维护处理遗留锁后重试。");
        }
        const result: TransactionCommit = { targetFile: batch.targetFile, transactions: batch.transactions, transactionText: batch.transactionText };
        return warnings.length ? { ...result, warnings } : result;
      } catch (error) {
        if (error instanceof FinanceError) {
          // 未知/占位的 replacement 不影响正式内容：失败时恢复可确定状态并清理。
          if (replacement !== undefined) await rm(replacement, { force: true }).catch(() => undefined);
          throw error;
        }
        if (publishStarted) {
          // 原子发布阶段结果无法确认：保留 replacement 供诊断恢复，禁止自动重试。
          throw new FinanceError("write_outcome_uncertain", "原子提交阶段发生异常，交易可能已经写入；请先查询正式账本再决定是否重试。");
        }
        if (replacement !== undefined) await rm(replacement, { force: true }).catch(() => undefined);
        if (signal?.aborted) throw new FinanceError("cancelled", "写入提交前已取消，正式账本未修改。");
        throw translateError(error);
      } finally {
        await lock.close().catch(() => undefined);
        if (!keepLock) await rm(lockPath, { force: true }).catch(() => undefined);
      }
    },
  };
}

function validateTransactions(input: Transaction | Transaction[]): Transaction[] {
  const transactions = Array.isArray(input) ? input : [input];
  if (transactions.length < 1) throw new FinanceError("invalid_transaction_batch", "交易提交必须包含至少 1 笔交易。");
  try {
    const years = new Set(transactions.map((transaction) => { validateDate(transaction.date); return transaction.date.slice(0, 4); }));
    if (years.size !== 1) throw new Error("一个交易批次只能包含同一自然年的交易");
    for (const transaction of transactions) {
      if (typeof transaction.description !== "string" || !transaction.description.trim() || /[\r\n\0]/u.test(transaction.description)) {
        throw new Error("description 必须是非空单行文本");
      }
      if (!Array.isArray(transaction.postings) || transaction.postings.length < 2) {
        throw new Error("一笔交易至少需要两个 postings");
      }
      const missingAmounts = transaction.postings.filter((posting) => !posting.amount).length;
      if (missingAmounts > 1) throw new Error("最多只能有一个 posting 省略 amount");
      for (const posting of transaction.postings) {
        if (typeof posting.account !== "string" || !posting.account.trim()) throw new Error("posting 账户必须是非空字符串");
        if (posting.amount !== undefined && posting.amount !== "" && (typeof posting.amount !== "string" || !posting.amount.trim())) {
          throw new Error("posting 金额必须是字符串");
        }
        if (typeof posting.amount === "string" && /[{}@]/u.test(posting.amount)) {
          throw new Error("普通候选交易不支持 cost、price 或 lot 语法");
        }
      }
    }
    return transactions;
  } catch (error) {
    throw new FinanceError("invalid_transaction_batch", `候选交易批次不符合普通交易约束：${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateDate(value: string): string {
  return readAbsoluteDate(value, "交易日期");
}

/**
 * 快照由 TypeScript 写入 module 独占计算：文件集合取自 Beancount bridge 本次
 * preview 实际加载的完整 include 图（loadedFiles），记录 default/ 内相对路径
 * 与文件字节 SHA-256，并单独记录目标年度文件存在状态；不重新实现 loader 的 glob。
 */
async function ledgerSnapshot(ledgerDirectory: string, loadedFiles: string[], targetFile: string, signal?: AbortSignal): Promise<LedgerSnapshot> {
  // bridge 返回的是 resolve 后的真实路径；根目录也取 realpath，避免 /var → /private/var 类符号链接偏差。
  const root = await realpath(resolve(ledgerDirectory));
  const files: Array<{ file: string; hash: string }> = [];
  for (const absolute of loadedFiles) {
    signal?.throwIfAborted();
    const resolved = await realpath(absolute);
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw new FinanceError("invalid_ledger_layout", "账本 include 必须指向 default/ 内部；请修复布局后重试。");
    }
    files.push({
      file: relative(root, resolved).replaceAll("\\", "/"),
      hash: createHash("sha256").update(await readFile(resolved)).digest("hex"),
    });
  }
  files.sort((left, right) => left.file.localeCompare(right.file));
  return { files, targetExists: await exists(join(root, targetFile)) };
}

function snapshotsEqual(left: LedgerSnapshot, right: LedgerSnapshot): boolean {
  if (left.targetExists !== right.targetExists) return false;
  if (left.files.length !== right.files.length) return false;
  const canonical = (list: LedgerSnapshot["files"]): string[] => list.map((entry) => `${entry.file}:${entry.hash}`).sort();
  const a = canonical(left.files);
  const b = canonical(right.files);
  return a.every((value, index) => value === b[index]);
}

/** 提交时把 bridge 重新加载的文件集合映射为 default/ 内相对路径，与预览快照的 include 集合逐项一致。 */
async function sameLoadSet(previous: LedgerSnapshot["files"], currentLoaded: string[], ledgerDirectory: string): Promise<boolean> {
  if (!Array.isArray(currentLoaded)) return false;
  const root = await realpath(resolve(ledgerDirectory));
  const current: string[] = [];
  for (const absolute of currentLoaded) {
    const resolved = await realpath(absolute);
    if (resolved !== root && !resolved.startsWith(root + sep)) return false;
    current.push(relative(root, resolved).replaceAll("\\", "/"));
  }
  current.sort();
  const previousNames = previous.map((entry) => entry.file).sort();
  return previousNames.length === current.length && previousNames.every((file, index) => file === current[index]);
}

async function acquireLedgerLock(lockPath: string) {
  try {
    return await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new FinanceError("ledger_locked", "账本正由另一笔财务写入占用；确认无其他写入进程后请通过账本维护处理遗留锁。");
    }
    throw error;
  }
}

async function readExisting(targetPath: string, createsFile: boolean): Promise<string | undefined> {
  try {
    return await readFile(targetPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT" && createsFile) return undefined;
    throw new FinanceError("preview_stale", "预览后目标年度文件状态已变化；请重新生成预览并再次确认。");
  }
}

async function writeReplacement(replacement: string, content: string, mode: number): Promise<void> {
  let handle;
  try {
    handle = await open(replacement, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function linkReplacement(replacement: string, targetPath: string): Promise<void> {
  try {
    await link(replacement, targetPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new FinanceError("preview_stale", "预览后目标年度文件已由外部程序创建；请重新生成预览并再次确认。");
    }
    throw error;
  }
}

/** 已有年度文件的字节保持不变：只在末尾补足一个空行分隔后追加规范文本。 */
function appendText(existing: string | undefined, text: string): string {
  if (existing === undefined || existing === "") return text;
  return `${existing.replace(/\n*$/u, "")}\n\n${text}`;
}

/** 发布成功后同步父目录；平台不支持目录同步时尽力而为，真实失败返回不确定写入。 */
async function syncDirectory(directory: string): Promise<void> {
  if (injectedFault("FSYNC_PARENT")) throw new Error("fsync parent fault");
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (isNodeError(error) && ["EPERM", "EISDIR", "ENOTSUP", "ENOSYS", "EBADF", "EINVAL"].includes(error.code ?? "")) return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * 测试专用故障注入钩子：仅当对应 MONEYPAL_FAULT_* 环境变量为 1 时生效，
 * 用于故障注入测试（发布失败、目录同步失败、锁清理失败）；生产环境保持为假。
 */
function injectedFault(name: string): boolean {
  return process.env[`MONEYPAL_FAULT_${name}`] === "1";
}

/** 预览阶段只向外抛受控 FinanceError：文件系统错误按阶段映射，不泄漏绝对路径或解释器细节。 */
function translatePreviewError(error: unknown): FinanceError {
  if (error instanceof FinanceError) return error;
  if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
    return new FinanceError("invalid_ledger_layout", "账本布局或 include 文件不可用；请修复布局后重试。");
  }
  return new FinanceError("internal_error", "账本预览未能完成；请稍后重试。");
}

/** 写入路径只向外抛受控 FinanceError：文件系统错误按阶段映射，不泄漏绝对路径或解释器细节。 */
function translateError(error: unknown): FinanceError {
  if (error instanceof FinanceError) return error;
  if (isNodeError(error) && (error.code === "ENOENT" || error.code === "EACCES")) {
    return new FinanceError("preview_stale", "预览后账本文件状态已变化；请重新生成预览并再次确认。");
  }
  return new FinanceError("internal_error", "账本写入未能完成；请稍后重试。");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
