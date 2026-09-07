export interface MoneyAmount { commodity: string; quantity: string; }
export interface AppliedRange { begin: string | null; end: string | null; }
export interface AccountAmounts { account: string; amounts: MoneyAmount[]; }
export interface ReportSection { accounts: AccountAmounts[]; totals: MoneyAmount[]; }
export interface Posting { account: string; amount?: string; }
export interface Transaction { date: string; description: string; postings: Posting[]; }
export interface DateRange { begin?: string; end?: string; }
export interface AccountQuery extends DateRange { account?: string; }
/** 完整流水在账户区间之上扩展的领域参数；余额等其它账户查询不携带。 */
export interface RegisterQuery extends AccountQuery { text?: string; limit?: number; }
export type MetadataValue = string | boolean | null | MetadataValue[] | { [key: string]: MetadataValue };
export interface Cost { currency: string; number: string; date: string | null; label: string | null; }
export interface RegisterPosting { account: string; units: MoneyAmount; cost: Cost | null; price: MoneyAmount | null; flag: string | null; metadata: Record<string, MetadataValue>; }
export interface RegisterTransaction { date: string; flag: string; payee: string | null; narration: string; tags: string[]; links: string[]; metadata: Record<string, MetadataValue>; postings: RegisterPosting[]; }
export interface RegisterResult { range: AppliedRange; truncated: boolean; transactions: RegisterTransaction[]; }
export interface BalanceResult { range: AppliedRange; accounts: AccountAmounts[]; totals: MoneyAmount[]; }
export interface IncomeStatement { range: AppliedRange; income: ReportSection; expenses: ReportSection; netIncome: MoneyAmount[]; }
export interface BalanceSheet { range: AppliedRange; assets: ReportSection; liabilities: ReportSection; equity: ReportSection; totals: { assets: MoneyAmount[]; liabilitiesAndEquity: MoneyAmount[]; }; }
export interface DuplicateWarning {
  candidateIndex: number;
  source: "ledger" | "batch";
  matchedCandidateIndex: number | null;
  existingDate: string;
  existingPayee: string | null;
  existingNarration: string;
  reasons: Array<"same_payee_and_narration" | "same_expense_accounts">;
}
export interface AmountSummary { commodity: string; income: string; expenses: string; netIncome: string; }
export interface TransactionPreview {
  targetFile: string;
  createsFile: boolean;
  transactions: string[];
  transactionText: string;
  validation: "passed";
  amountSummary: AmountSummary[];
  duplicateWarnings: DuplicateWarning[];
}
export interface TransactionCommit { targetFile: string; transactions: string[]; transactionText: string; warnings?: string[]; }
/** 上层唯一依赖的账本领域 seam。 */
export interface LedgerEngine {
  validateJournal(signal?: AbortSignal): Promise<{ valid: true }>;
  listAccounts(signal?: AbortSignal): Promise<{ accounts: string[] }>;
  queryRegister(query?: RegisterQuery, signal?: AbortSignal): Promise<RegisterResult>;
  getBalance(query?: AccountQuery, signal?: AbortSignal): Promise<BalanceResult>;
  getIncomeStatement(range?: DateRange, signal?: AbortSignal): Promise<IncomeStatement>;
  getBalanceSheet(range?: DateRange, signal?: AbortSignal): Promise<BalanceSheet>;
}
