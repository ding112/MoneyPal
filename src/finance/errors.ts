export type FinanceErrorCode =
  | "invalid_workspace" | "invalid_ledger_layout" | "ledger_already_initialized" | "runtime_unavailable"
  | "journal_invalid" | "invalid_transaction_batch" | "undeclared_account"
  | "write_requires_root_agent" | "cancelled" | "preview_stale" | "ledger_locked"
  | "write_outcome_uncertain" | "batch_unavailable" | "batch_expired" | "batch_submitted"
  | "batch_replaced" | "batch_committing" | "batch_commit_failed" | "batch_outcome_uncertain"
  | "invalid_request"
  | "invalid_configuration" | "operation_timeout" | "result_too_large" | "internal_error";

export interface ValidationDiagnostic {
  severity: "error";
  location: { file: string | null; line: number | null };
  message: string;
  action: string;
}

/** 财务边界唯一可公开的错误形状；消息不得拼接解释器或账本细节。 */
export class FinanceError extends Error {
  constructor(readonly code: FinanceErrorCode, message: string, readonly diagnostics?: ValidationDiagnostic[]) {
    super(message);
    this.name = "FinanceError";
  }
}

export function asFinanceError(error: unknown): FinanceError {
  if (error instanceof FinanceError) return error;
  return new FinanceError("internal_error", "账本操作未能完成；请稍后重试。");
}
