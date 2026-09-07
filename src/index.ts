// DSH 装配契约：包根必须同时承担 Cordis 宿主入口与客户端包发现，
// bundle patch 以精确包根挂载；这些导出不是冗余的领域 API。
export { apply, inject, name } from "./host.js";
export { createConfirmedTransactionWriter } from "./finance/write.js";
export { installPreset } from "./install-preset.js";
export { initializeLedger } from "./init-ledger.js";
export { createLedgerEngine } from "./finance/engine.js";
export { FinanceError } from "./finance/errors.js";
export { inspectRuntime, setupRuntime } from "./finance/runtime.js";
export { readBalanceSnapshot } from "./balance.js";
export type { BalanceAccount, BalanceGroup, BalanceSnapshot } from "./balance.js";
export type {
  AccountQuery,
  DateRange,
  Posting,
  Transaction,
  TransactionPreview,
} from "./finance/types.js";
export type { ConfirmedTransactionWriter, ConfirmedWriteOptions } from "./finance/write.js";
export type { InitializeLedgerOptions } from "./init-ledger.js";
export type { LedgerEngineOptions } from "./finance/engine.js";
export type { RuntimeStatus, SetupRuntimeOptions } from "./finance/runtime.js";
export type { LedgerEngine, MoneyAmount, AppliedRange, AccountAmounts, ReportSection, RegisterQuery, RegisterResult, BalanceResult, IncomeStatement, BalanceSheet, TransactionCommit } from "./finance/types.js";
export type { FinanceErrorCode as MoneyPalFinanceErrorCode } from "./finance/errors.js";
