// DSH 装配契约：包根必须同时承担 Cordis 宿主入口与客户端包发现，
// bundle patch 以精确包根挂载；这些导出不是冗余的领域 API。
export { apply, inject, name } from "./host.js";
export { createConfirmedTransactionWriter } from "./core/dist/src/write.js";
export { initializeLedger } from "./core/dist/src/init.js";
export { createLedgerEngine } from "./core/dist/src/ledger.js";
export { FinanceError } from "./core/dist/src/contracts.js";
export { inspectRuntime, setupRuntime } from "./core/dist/src/runtime.js";
export { readBalanceSnapshot } from "./balance.js";
export type { BalanceAccount, BalanceGroup, BalanceSnapshot } from "./balance.js";
export type {
  AccountQuery,
  DateRange,
} from "./core/dist/src/ledger.js";
export type { ConfirmedTransactionWriter, ConfirmedWriteOptions } from "./core/dist/src/write.js";
export type { InitializeLedgerOptions } from "./core/dist/src/init.js";
export type { LedgerEngineOptions } from "./core/dist/src/ledger.js";
export type { RuntimeStatus, SetupRuntimeOptions } from "./core/dist/src/runtime.js";
export type { LedgerEngine, MoneyAmount, AppliedRange, AccountAmounts, ReportSection, RegisterQuery, RegisterResult, BalanceResult, IncomeStatement, BalanceSheet } from "./core/dist/src/ledger.js";
export type { FinanceErrorCode as MoneyPalFinanceErrorCode } from "./core/dist/src/contracts.js";

export type { Posting, Transaction, TransactionPreview, TransactionCommit } from "./core/dist/src/write.js";
