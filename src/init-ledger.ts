import { access, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { FinanceError } from "./finance/errors.js";

const MAIN_BEANCOUNT = 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n';
const INITIAL_ACCOUNTS = [
  "Assets:C-现金",
  "Liabilities:C-信用卡",
  "Equity:C-期初余额",
  "Expenses:C-餐饮",
  "Income:C-工资",
] as const;

function accountsBeancount(year: number): string {
  return [
  `${year}-01-01 commodity CNY`,
  "",
  ...INITIAL_ACCOUNTS.map((account) => `${year}-01-01 open ${account}`),
  "",
  ].join("\n");
}

export interface InitializeLedgerOptions {
  ledgerWorkspace?: string;
  year?: number;
}

export interface LedgerInitializationPlan {
  ledgerDirectory: "default";
  year: number;
  files: readonly string[];
  accounts: readonly string[];
}

/**
 * 返回可展示给用户的初始化计划，并在确认前拒绝已有账本。
 * initializeLedger 仍会在实际创建时重复检查，以防确认期间发生竞态。
 */
export async function planLedgerInitialization(options: InitializeLedgerOptions = {}): Promise<LedgerInitializationPlan> {
  const { ledgerWorkspace, year } = resolvedOptions(options);
  await assertLedgerMissing(ledgerWorkspace);
  return ledgerInitializationPlan(year);
}

export async function initializeLedger(options: InitializeLedgerOptions = {}): Promise<string> {
  const { ledgerWorkspace, year } = resolvedOptions(options);

  await mkdir(ledgerWorkspace, { recursive: true, mode: 0o700 });
  const ledgerDirectory = join(ledgerWorkspace, "default");
  try {
    await mkdir(ledgerDirectory, { mode: 0o700 });
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new FinanceError("ledger_already_initialized", "账本已存在；为避免覆盖，初始化已取消。");
    }
    throw error;
  }

  const transactions = join(ledgerDirectory, "transactions");
  const accounts = join(ledgerDirectory, "accounts.beancount");
  const transactionFile = join(transactions, `${year}.beancount`);
  const main = join(ledgerDirectory, "main.beancount");
  const created: string[] = [];
  try {
    await mkdir(transactions, { mode: 0o700 });
    created.push(transactions);
    await writeFile(accounts, accountsBeancount(year), { encoding: "utf8", flag: "wx", mode: 0o600 });
    created.push(accounts);
    await writeFile(transactionFile, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    created.push(transactionFile);
    // main.beancount 是账本有效布局的入口，最后写入才对外发布完整账本。
    await writeFile(main, MAIN_BEANCOUNT, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return ledgerDirectory;
  } catch (error) {
    await cleanIncompleteLedger(created, ledgerDirectory);
    throw error;
  }
}

function resolvedOptions(options: InitializeLedgerOptions): { ledgerWorkspace: string; year: number } {
  const ledgerWorkspace = resolve(options.ledgerWorkspace ?? process.cwd());
  const year = options.year ?? new Date().getFullYear();
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new Error("初始化年份必须是四位整数。");
  }
  return { ledgerWorkspace, year };
}

function ledgerInitializationPlan(year: number): LedgerInitializationPlan {
  return {
    ledgerDirectory: "default",
    year,
    files: ["default/accounts.beancount", `default/transactions/${year}.beancount`, "default/main.beancount"],
    accounts: [...INITIAL_ACCOUNTS],
  };
}

async function assertLedgerMissing(ledgerWorkspace: string): Promise<void> {
  try {
    await access(join(ledgerWorkspace, "default"));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  throw new FinanceError("ledger_already_initialized", "账本已存在；为避免覆盖，初始化已取消。");
}

async function cleanIncompleteLedger(created: readonly string[], ledgerDirectory: string): Promise<void> {
  for (const path of created.slice().reverse()) {
    if (path === join(ledgerDirectory, "transactions")) await rmdir(path).catch(() => undefined);
    else await rm(path, { force: true }).catch(() => undefined);
  }
  await rmdir(ledgerDirectory).catch(() => undefined);
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
