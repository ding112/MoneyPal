import type { LedgerEngine } from "./core/dist/src/ledger.js";
import { readString, readPositiveInteger, readStatementRange } from "./core/dist/src/contracts.js";
export * from "./core/dist/src/contracts.js";

/** 已迁移到 Beancount 的只读领域操作；宿主只能依赖 LedgerEngine 的公开 DTO。 */
export const LEDGER_ENGINE_OPERATIONS: Pick<Record<string, (engine: LedgerEngine, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>>, "finance_query_register" | "finance_get_balance" | "finance_get_income_statement" | "finance_get_balance_sheet" | "finance_list_accounts" | "finance_validate_journal"> = {
  finance_query_register: (engine, args, signal) => engine.queryRegister(readRegisterQuery(args), signal),
  finance_get_balance: (engine, args, signal) => engine.getBalance(readAccountRange(args), signal),
  finance_get_income_statement: (engine, args, signal) => engine.getIncomeStatement(readStatementRange(args), signal),
  finance_get_balance_sheet: (engine, args, signal) => engine.getBalanceSheet(readStatementRange(args), signal),
  finance_list_accounts: (engine, _args, signal) => engine.listAccounts(signal),
  finance_validate_journal: (engine, _args, signal) => engine.validateJournal(signal),
};

export function readRange(args: Record<string, unknown>): { begin?: string; end?: string } {
  return { ...readString(args, "begin"), ...readString(args, "end") };
}

export function readAccountRange(args: Record<string, unknown>): { account?: string; begin?: string; end?: string } {
  return { ...readString(args, "account"), ...readRange(args) };
}

/** 完整流水在账户区间之上读取文本与数量限制；其余账户查询不携带这两个参数。 */
export function readRegisterQuery(args: Record<string, unknown>): { account?: string; begin?: string; end?: string; text?: string; limit?: number } {
  return { ...readAccountRange(args), ...readString(args, "text"), ...readPositiveInteger(args, "limit") };
}

