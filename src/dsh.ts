import {
  errorResponse,
  INITIALIZE_LEDGER_OUTPUT_SCHEMA,
  INITIALIZE_LEDGER_TOOL_DEFINITION,
  LEDGER_ENGINE_OPERATIONS,
  readTransactions,
  READ_ONLY_TOOL_DEFINITIONS,
  WRITE_TOOL_PARAMETERS,
  type ToolDefinition,
} from "./finance/contract.js";
import { asFinanceError, FinanceError } from "./finance/errors.js";
import { createLedgerEngine } from "./finance/engine.js";
import { createConfirmedTransactionWriter } from "./finance/write.js";
import { initializeLedger, planLedgerInitialization } from "./init-ledger.js";

type ToolArguments = Record<string, unknown>;

interface DshExecution {
  agent?: { session?: { header?: { cwd?: unknown; parentSession?: unknown } } };
  signal: AbortSignal;
}

interface DshTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: Record<string, unknown>;
  timeoutMs?: number;
  isConcurrencySafe: () => boolean;
  execute(args: ToolArguments, execution: DshExecution): Promise<unknown>;
}

interface DshContext {
  tools: { register(tool: DshTool): unknown };
  systemPrompt: {
    section(section: { name: string; order: number; text: string | (() => string) }): () => void;
  };
  effect(callback: () => () => void, name?: string): unknown;
  userQuestions?: { ask(request: { questions: Array<{ id: string; question: string; detail?: string; header?: string; options: Array<{ label: string; description: string }>; intent?: { kind: "plan-review"; approve: string } }> ; agent?: DshExecution["agent"]; signal: AbortSignal }): Promise<{ answers: Array<{ id: string; selected: string[] }> }> };
}

const RESPONSE_OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
};

export const name = "dsh-moneypal";
export const inject = ["tools", "userQuestions", "systemPrompt"];

export function apply(ctx: DshContext): void {
  ctx.effect(() => ctx.systemPrompt.section({
    name: "dsh-moneypal:date-defaults",
    order: 50,
    text: [
      "财务日期解释规则：",
      "- 当前日期、时间和时区只能以本次请求的 time-context 为准。",
      "- 用户说“今天”“昨天”“明天”或仅给出月、日时，必须基于 time-context 的准确日期换算。",
      "- 用户给出月、日但未指定年份时，采用 time-context 中的当前年份。",
      "- 用户明确指定年份时，不得替换该年份。",
      "- 调用财务工具前，将日期转换为合法的 YYYY-MM-DD。",
      "- time-context 缺失、时区不可用或时区混合时，必须请用户澄清；不得臆造日期。",
      "- 若补全后日期无效，应向用户说明，不得擅自改成其他日期。",
    ].join("\n"),
  }), "dsh-moneypal.date-defaults()");

  for (const definition of READ_ONLY_TOOL_DEFINITIONS) {
    registerLedgerEngine(ctx, definition, LEDGER_ENGINE_OPERATIONS[definition.name as keyof typeof LEDGER_ENGINE_OPERATIONS]!);
  }
  registerWrite(ctx);
  registerLedgerInitialization(ctx);
}

function registerLedgerEngine(
  ctx: DshContext,
  definition: ToolDefinition,
  operation: (engine: ReturnType<typeof createLedgerEngine>, args: ToolArguments, signal: AbortSignal) => Promise<unknown>,
): void {
  ctx.tools.register({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    output: RESPONSE_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      try {
        return await operation(createLedgerEngine({ ledgerWorkspace: workspaceFor(execution) }), args, execution.signal);
      } catch (error) {
        return { error: errorResponse(error) };
      }
    },
  });
}

function registerWrite(ctx: DshContext): void {
  ctx.tools.register({
    name: "finance_add_transactions",
    description: "预览同年度普通候选交易；整份提交经一次人工确认后原子写入正式账本，预览文本与最终写入字节完全一致。",
    parameters: WRITE_TOOL_PARAMETERS,
    output: RESPONSE_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args, execution) {
      try {
        if (execution.agent?.session?.header?.parentSession !== undefined) {
          throw new FinanceError("write_requires_root_agent", "子 Agent 不能写入正式账本；请将候选交易交回根 Web Agent 以生成预览并确认。");
        }
        const transactions = readTransactions(args);
        const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: workspaceFor(execution) });
        const preview = await writer.preview(transactions, execution.signal);
        const duplicateSummary = preview.duplicateWarnings.length
          ? [
              "## 可能重复",
              "",
              ...preview.duplicateWarnings.map((warning) => `- 第 ${warning.candidateIndex + 1} 笔可能与 ${warning.existingDate} 的“${warning.existingNarration || warning.existingPayee || "无描述"}”重复：${warning.reasons.map(duplicateReasonLabel).join("；")}`),
            ].join("\n")
          : undefined;
        const detail = [
          `共 **${preview.transactions.length}** 笔交易。`,
          preview.amountSummary.length ? [
            "## 收支汇总",
            "",
            "| 币种 | 收入 | 支出 | 净额 |",
            "| --- | ---: | ---: | ---: |",
            ...preview.amountSummary.map((summary) => `| ${summary.commodity} | ${summary.income} | ${summary.expenses} | ${summary.netIncome} |`),
          ].join("\n") : undefined,
          "## 交易明细",
          `\`\`\`text\n${preview.transactionText.trimEnd()}\n\`\`\``,
          duplicateSummary,
        ].filter((part) => part !== undefined).join("\n\n");
        const answer = await ctx.userQuestions?.ask({
          questions: [{
            id: "confirm_finance_write",
            question: "确认执行这份记账计划吗？",
            detail,
            options: [
              { label: "记入", description: "按以上内容记账。" },
              { label: "取消", description: "不写入账本，可修改后重试。" },
            ],
            intent: { kind: "plan-review", approve: "记入" },
          }],
          agent: execution.agent,
          signal: execution.signal,
        });
        if (answer?.answers.find((item) => item.id === "confirm_finance_write")?.selected[0] !== "记入") {
          throw new FinanceError("cancelled", "已取消写入，正式账本未修改。");
        }
        return await writer.commit(execution.signal);
      } catch (error) {
        if (execution.signal.aborted && !(error instanceof FinanceError)) {
          return { error: errorResponse(new FinanceError("cancelled", "已取消写入，正式账本未修改。")) };
        }
        return { error: errorResponse(error) };
      }
    },
  });
}

function registerLedgerInitialization(ctx: DshContext): void {
  ctx.tools.register({
    name: INITIALIZE_LEDGER_TOOL_DEFINITION.name,
    description: INITIALIZE_LEDGER_TOOL_DEFINITION.description,
    parameters: INITIALIZE_LEDGER_TOOL_DEFINITION.parameters,
    output: {
      schema: INITIALIZE_LEDGER_OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown) => [{ type: "text", text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => false,
    async execute(_args, execution) {
      try {
        if (execution.agent?.session?.header?.parentSession !== undefined) {
          throw new FinanceError("write_requires_root_agent", "子 Agent 不能初始化账本；请交由根 Web Agent 发起并确认。");
        }
        const workspace = workspaceFor(execution);
        const year = new Date().getFullYear();
        const plan = await planLedgerInitialization({ ledgerWorkspace: workspace, year });
        const answer = await ctx.userQuestions?.ask({
          questions: [{
            id: "confirm_ledger_initialization",
            question: "确认初始化当前工作区的账本吗？",
            detail: [
              `将创建 **${plan.year}** 年账本。`,
              "## 文件",
              plan.files.map((file) => `- \`${file}\``).join("\n"),
              "## 基础账户",
              ["- 商品：`CNY`", ...plan.accounts.map((account) => `- \`${account}\``)].join("\n"),
            ].join("\n\n"),
            options: [
              { label: "初始化", description: "创建账本和基础账户。" },
              { label: "取消", description: "不创建任何账本文件。" },
            ],
            intent: { kind: "plan-review", approve: "初始化" },
          }],
          agent: execution.agent,
          signal: execution.signal,
        });
        if (answer?.answers.find((item) => item.id === "confirm_ledger_initialization")?.selected[0] !== "初始化") {
          throw new FinanceError("cancelled", "已取消初始化，工作区未修改。");
        }
        await initializeLedger({ ledgerWorkspace: workspace, year: plan.year });
        return { initialized: true, ...plan };
      } catch (error) {
        if (execution.signal.aborted && !(error instanceof FinanceError)) {
          return { error: errorResponse(new FinanceError("cancelled", "已取消初始化，工作区未修改。")) };
        }
        return { error: errorResponse(asFinanceError(error)) };
      }
    },
  });
}

function duplicateReasonLabel(reason: "same_payee_and_narration" | "same_expense_accounts"): string {
  return reason === "same_payee_and_narration" ? "描述相同" : "费用账户相同";
}

function workspaceFor(execution: DshExecution): string {
  const cwd = execution.agent?.session?.header?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new FinanceError("invalid_workspace", "无法取得调用所属的账本工作区；请在 DSH Web 中打开账本工作区后重试。");
  }
  return cwd;
}
