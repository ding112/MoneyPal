import { FinanceError } from "./errors.js";
import type { LedgerEngine, Transaction } from "./types.js";
import { readAbsoluteDate } from "./date.js";

/**
 * DSH 与 MCP 两个宿主适配器共用的财务工具契约：
 * 工具名称、描述、参数 JSON Schema、参数读取与错误响应构造都在这里定义，
 * 任何一侧修改都会同步到另一侧，避免两个宿主面漂移。
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const EMPTY_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

export const INITIALIZE_LEDGER_TOOL_DEFINITION: ToolDefinition = {
  name: "finance_initialize_ledger",
  description: "在当前 DSH 工作区创建固定的 Beancount 账本布局和基础账户。仅根 Agent 可调用，必须在用户确认后执行；已有 default/ 时拒绝覆盖。",
  parameters: EMPTY_PARAMETERS,
};

export const INITIALIZE_LEDGER_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        // DSH 的输出 Schema 子集要求 const 同时声明标量类型，且不支持
        // minimum/maximum；年份范围仍由 init-ledger.ts 在执行边界校验。
        initialized: { type: "boolean", const: true },
        ledgerDirectory: { type: "string", const: "default" },
        year: { type: "integer" },
        files: { type: "array", items: { type: "string" } },
        accounts: { type: "array", items: { type: "string" } },
      },
      required: ["initialized", "ledgerDirectory", "year", "files", "accounts"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            diagnostics: { type: "array" },
          },
          required: ["code", "message"],
          additionalProperties: false,
        },
      },
      required: ["error"],
      additionalProperties: false,
    },
  ],
} as const;
const RANGE_PARAMETERS = {
  type: "object",
  properties: {
    begin: { type: "string", description: "起始日期，必须是绝对日期 YYYY-MM-DD。" },
    end: { type: "string", description: "结束日期，必须是绝对日期 YYYY-MM-DD，作为排他边界处理。" },
  },
  additionalProperties: false,
};
const ACCOUNT_RANGE_PARAMETERS = {
  type: "object",
  properties: {
    account: { type: "string", description: "可选的账户名称。" },
    ...RANGE_PARAMETERS.properties,
  },
  additionalProperties: false,
};
const REGISTER_PARAMETERS = {
  type: "object",
  properties: {
    ...ACCOUNT_RANGE_PARAMETERS.properties,
    text: { type: "string", description: "可选的大小写敏感文本；匹配交易的 payee 或 narration。" },
    limit: { type: "integer", minimum: 1, description: "可选的最大返回交易数；结果另以 truncated 标识是否仍有匹配交易。" },
  },
  additionalProperties: false,
};
const TRANSACTION_PARAMETERS = {
  type: "object",
  properties: {
    transactions: {
      type: "array",
      description: "同一自然年的普通候选交易；整批一次预览、一次确认、一次原子提交。",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          date: { type: "string", description: "交易日期，YYYY-MM-DD。" },
          description: { type: "string", description: "交易说明（成为 Beancount narration），非空单行文本。" },
          postings: {
            type: "array",
            description: "至少两个分录；最多一个分录可省略 amount，由 Beancount booking 推导平衡金额。",
            minItems: 2,
            items: {
              type: "object",
              properties: {
                account: { type: "string", description: "已在 accounts.beancount 中声明的账户名称。" },
                amount: { type: "string", description: "可选金额，格式如 286 CNY 或 -12.50 USD；整笔交易只能使用一种商品。" },
              },
              required: ["account"],
              additionalProperties: false,
            },
          },
        },
        required: ["date", "description", "postings"],
        additionalProperties: false,
      },
    },
  },
  required: ["transactions"],
  additionalProperties: false,
};

const DATE_RULE = "日期参数必须使用绝对日期 YYYY-MM-DD，不接受“今天”“昨天”等相对表述。";

export const READ_ONLY_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  { name: "finance_query_register", description: `按账户、文本、日期区间查询正式账本流水。${DATE_RULE}`, parameters: REGISTER_PARAMETERS },
  { name: "finance_get_balance", description: `按账户和日期区间查询正式账本余额。${DATE_RULE}`, parameters: ACCOUNT_RANGE_PARAMETERS },
  { name: "finance_get_income_statement", description: `按日期区间查询正式账本期间损益表：只按 Beancount Income 与 Expenses 账户分类，begin 含、end 不含，金额按商品保留原始币种。${DATE_RULE}`, parameters: RANGE_PARAMETERS },
  { name: "finance_get_balance_sheet", description: `按日期区间查询正式账本期末资产负债表：按 Beancount Assets、Liabilities 与 Equity 账户分类，保留期初、收益与转换权益账户，begin 含、end 不含，金额按商品保留原始币种。${DATE_RULE}`, parameters: RANGE_PARAMETERS },
  { name: "finance_list_accounts", description: "仅返回正式账本中声明的账户名称。", parameters: EMPTY_PARAMETERS },
  { name: "finance_validate_journal", description: "校验整个正式账本。", parameters: EMPTY_PARAMETERS },
];

export const WRITE_TOOL_PARAMETERS = TRANSACTION_PARAMETERS;

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

/** 财务报表的日期区间必须是合法绝对日期，且 begin 早于 end；违反时经宿主映射为 invalid_request。 */
export function readStatementRange(args: Record<string, unknown>): { begin?: string; end?: string } {
  const begin = readDate(args, "begin");
  const end = readDate(args, "end");
  if (begin !== undefined && end !== undefined && begin >= end) {
    throw new RangeError("begin 必须早于 end（end 为排他边界）。");
  }
  return { ...(begin !== undefined ? { begin } : {}), ...(end !== undefined ? { end } : {}) };
}

function readDate(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  return readAbsoluteDate(value, "日期参数");
}

function readString(args: Record<string, unknown>, key: string): Record<string, string> {
  const value = args[key];
  if (value === undefined) return {};
  if (typeof value !== "string") throw new TypeError(`${key} 必须是字符串`);
  return { [key]: value };
}

function readPositiveInteger(args: Record<string, unknown>, key: string): Record<string, number> {
  const value = args[key];
  if (value === undefined) return {};
  if (!Number.isInteger(value) || (value as number) < 1) throw new TypeError(`${key} 必须是正整数`);
  return { [key]: value as number };
}

export function readTransactions(args: Record<string, unknown>): Transaction[] {
  if (!Array.isArray(args.transactions) || args.transactions.length < 1) {
    throw new FinanceError("invalid_transaction_batch", "transactions 必须包含至少 1 笔候选交易。");
  }
  return args.transactions as Transaction[];
}

export function errorResponse(error: unknown): { code: string; message: string; diagnostics?: import("./errors.js").ValidationDiagnostic[] } {
  if (error instanceof FinanceError) return { code: error.code, message: error.message, ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) };
  if (error instanceof Error) return { code: "invalid_request", message: error.message };
  return { code: "invalid_request", message: String(error) };
}
