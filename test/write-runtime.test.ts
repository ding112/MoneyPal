import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createLedgerEngine } from "../src/finance/engine.js";
import { FinanceError } from "../src/finance/errors.js";
import { inspectRuntime } from "../src/finance/runtime.js";
import { initializeLedger } from "../src/init-ledger.js";
import { createConfirmedTransactionWriter } from "../src/finance/write.js";
import type { Transaction } from "../src/finance/types.js";

/** 本文件在真实 MoneyPal 运行时上验证写入路径的 Beancount 语义；未安装时整体跳过。 */
const runtime = await inspectRuntime().catch(() => undefined);
const skip = runtime?.available ? false : "未检测到可用的 MoneyPal 运行时；请先执行 setup-runtime。";

let root: string;

const ACCOUNTS = `2025-01-01 commodity CNY
2025-01-01 commodity USD
2025-01-01 open Assets:C-钱包
2025-01-01 open Assets:C-储蓄
2025-01-01 open Income:C-工资
2025-01-01 open Expenses:C-餐饮
2025-01-01 open Expenses:C-旧项目
2025-12-31 close Expenses:C-旧项目
2027-01-01 open Assets:C-未来
2026-01-01 open Assets:C-外币 USD
`;

const EXISTING = `2026-08-25 * "午餐"
  Expenses:C-餐饮   12 CNY
  Assets:C-钱包    -12 CNY

2026-08-01 * "雇主" "工资"
  Assets:C-钱包     100 CNY
  Income:C-工资    -100 CNY
`;

const tx = (date: string, description: string, postings: Array<{ account: string; amount?: string }>) => ({ date, description, postings });

before(async () => {
  if (skip) return;
  root = await mkdtemp(join(tmpdir(), "moneypal-write-runtime-"));
});

after(async () => {
  if (skip) return;
  await rm(root, { recursive: true, force: true });
});

async function makeLedger(name: string): Promise<{ workspace: string; ledger: string; transactions: string }> {
  const workspace = join(root, name);
  const ledger = await initializeLedger({ ledgerWorkspace: workspace, year: 2026 });
  await writeFile(join(ledger, "accounts.beancount"), ACCOUNTS, "utf8");
  await writeFile(join(ledger, "transactions", "2026.beancount"), EXISTING, "utf8");
  return { workspace, ledger, transactions: join(ledger, "transactions", "2026.beancount") };
}

test("预览生成与 Beancount 完全一致的规范文本、收支汇总与重复提醒", { skip }, async () => {
  const { workspace } = await makeLedger("preview");
  const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: workspace });
  const preview = await writer.preview([
    tx("2026-08-26", "工资", [{ account: "Assets:C-钱包", amount: "100 CNY" }, { account: "Income:C-工资" }]),
    tx("2026-08-27", "晚餐", [{ account: "Expenses:C-餐饮", amount: "30.5 CNY" }, { account: "Assets:C-钱包" }]),
    tx("2026-08-28", "午餐", [{ account: "Expenses:C-餐饮", amount: "12 CNY" }, { account: "Assets:C-钱包" }]),
    tx("2026-08-29", "转账", [{ account: "Assets:C-储蓄", amount: "20 CNY" }, { account: "Assets:C-钱包", amount: "-20 CNY" }]),
  ]);

  assert.equal(preview.validation, "passed");
  assert.equal(preview.targetFile, "transactions/2026.beancount");
  assert.equal(preview.createsFile, false);
  assert.equal(preview.transactions.length, 4);
  assert.equal(preview.transactionText, preview.transactions.join("\n"), "transactionText 必须按输入顺序以单个空行连接各笔规范指令");
  assert.match(preview.transactions[0]!, /^2026-08-26 \* "工资"\n  Assets:C-钱包 .*100 CNY\n  Income:C-工资 .*-100 CNY\n$/u);
  assert.match(preview.transactions[1]!, /^2026-08-27 \* "晚餐"\n  Expenses:C-餐饮 .*30\.5 CNY\n  Assets:C-钱包 .*-30\.5 CNY\n$/u);
  assert.match(preview.transactions[2]!, /^2026-08-28 \* "午餐"\n  Expenses:C-餐饮 .*12 CNY\n  Assets:C-钱包 .*-12 CNY\n$/u);
  assert.match(preview.transactions[3]!, /^2026-08-29 \* "转账"\n  Assets:C-储蓄 .*20 CNY\n  Assets:C-钱包 .*-20 CNY\n$/u);
  assert.deepEqual(preview.amountSummary, [{ commodity: "CNY", income: "100", expenses: "42.5", netIncome: "57.5" }]);
  // 同批较早候选不计重复——只有与正式账本 2026-08-25 午餐的命中。
  assert.deepEqual(preview.duplicateWarnings, [{
    candidateIndex: 2,
    source: "ledger",
    matchedCandidateIndex: null,
    existingDate: "2026-08-25",
    existingPayee: null,
    existingNarration: "午餐",
    reasons: ["same_payee_and_narration", "same_expense_accounts"],
  }]);
});

test("预览文本逐字节等于最终写入文本，且写入后可被 Beancount 重新加载验证", { skip }, async () => {
  const { workspace, transactions } = await makeLedger("byte-identity");
  const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: workspace });
  const preview = await writer.preview([
    tx("2026-08-26", "午餐", [{ account: "Expenses:C-餐饮", amount: "12 CNY" }, { account: "Assets:C-钱包" }]),
    tx("2026-08-27", "工资", [{ account: "Assets:C-钱包", amount: "100 CNY" }, { account: "Income:C-工资" }]),
  ]);
  const result = await writer.commit();
  assert.equal(result.transactionText, preview.transactionText);
  assert.deepEqual(result.transactions, preview.transactions);
  assert.equal(result.targetFile, "transactions/2026.beancount");
  assert.equal(await readFile(transactions, "utf8"), `${EXISTING.trimEnd()}\n\n${result.transactionText}`);

  const engine = createLedgerEngine({ ledgerWorkspace: workspace });
  assert.deepEqual(await engine.validateJournal(), { valid: true });
  const register = await engine.queryRegister({ begin: "2026-08-26", end: "2026-08-28" });
  assert.deepEqual(register.transactions.map((entry) => entry.narration), ["午餐", "工资"]);
  assert.deepEqual(register.transactions[0]!.postings.map((posting) => posting.units), [
    { commodity: "CNY", quantity: "12" },
    { commodity: "CNY", quantity: "-12" },
  ]);
});

test("候选账户约束映射为确定的错误码且零写入", { skip }, async () => {
  const { workspace, transactions } = await makeLedger("account-constraints");
  const before = await readFile(transactions, "utf8");
  const cases: Array<[string, Transaction]> = [
    ["undeclared_account", tx("2026-09-01", "未声明", [{ account: "Expenses:Nope", amount: "1 CNY" }, { account: "Assets:C-钱包" }])],
    ["invalid_transaction_batch", tx("2026-02-01", "未开放", [{ account: "Expenses:C-餐饮", amount: "1 CNY" }, { account: "Assets:C-未来" }])],
    ["invalid_transaction_batch", tx("2026-02-01", "已关闭", [{ account: "Expenses:C-旧项目", amount: "1 CNY" }, { account: "Assets:C-钱包" }])],
    ["invalid_transaction_batch", tx("2026-09-01", "外币受限", [{ account: "Expenses:C-餐饮", amount: "1 CNY" }, { account: "Assets:C-外币" }])],
    ["invalid_transaction_batch", tx("2026-09-01", "多商品", [{ account: "Expenses:C-餐饮", amount: "10 CNY" }, { account: "Assets:C-外币", amount: "-5 USD" }])],
    ["invalid_transaction_batch", tx("2026-09-01", "旧语法", [{ account: "Expenses:C-餐饮", amount: ".5 CNY" }, { account: "Assets:C-钱包" }])],
    ["invalid_transaction_batch", tx("2026-09-01", "无商品", [{ account: "Expenses:C-餐饮", amount: "10" }, { account: "Assets:C-钱包" }])],
    ["invalid_transaction_batch", tx("2026-09-01", "不平衡", [{ account: "Expenses:C-餐饮", amount: "10 CNY" }, { account: "Assets:C-钱包", amount: "-9 CNY" }])],
  ];
  for (const [code, candidate] of cases) {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: workspace });
    await assert.rejects(writer.preview(candidate), (error: unknown) => error instanceof FinanceError && error.code === code);
    assert.equal(await readFile(transactions, "utf8"), before, `${code} 必须零写入`);
  }
});

test("跨年批次整体拒绝，重复提醒按确定性顺序排列", { skip }, async () => {
  const { workspace } = await makeLedger("batch-duplicates");
  const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: workspace });
  await assert.rejects(
    writer.preview([tx("2026-09-01", "午餐", [{ account: "Expenses:C-餐饮", amount: "1 CNY" }, { account: "Assets:C-钱包" }]), tx("2027-01-01", "跨年", [{ account: "Expenses:C-餐饮", amount: "1 CNY" }, { account: "Assets:C-钱包" }])]),
    (error: unknown) => error instanceof FinanceError && error.code === "invalid_transaction_batch",
  );

  const preview = await writer.preview([
    tx("2026-08-25", "午餐", [{ account: "Expenses:C-餐饮", amount: "12 CNY" }, { account: "Assets:C-钱包" }]),
    tx("2026-08-28", "午餐", [{ account: "Expenses:C-餐饮", amount: "12 CNY" }, { account: "Assets:C-钱包" }]),
    tx("2026-08-29", "午餐", [{ account: "Expenses:C-餐饮", amount: "12 CNY" }, { account: "Assets:C-钱包" }]),
  ]);
  const warnings = preview.duplicateWarnings;
  // 第 0 笔命中正式账本；第 1 笔命中正式账本与同批较早候选；第 2 笔（08-29）窗口
  // 起点为 08-26，仅命中同批第 1 笔。
  assert.deepEqual(warnings.map((warning) => warning.candidateIndex), [0, 1, 1, 2]);
  assert.deepEqual(warnings[0], {
    candidateIndex: 0, source: "ledger", matchedCandidateIndex: null, existingDate: "2026-08-25", existingPayee: null, existingNarration: "午餐", reasons: ["same_payee_and_narration", "same_expense_accounts"],
  });
  assert.deepEqual(warnings.map((warning) => warning.source), ["ledger", "ledger", "batch", "batch"]);
  assert.deepEqual(warnings.map((warning) => warning.matchedCandidateIndex), [null, null, 0, 1]);
});

test("预览后账本变化时提交以 preview_stale 拒绝，新年度文件提交后整本账本可加载", { skip }, async () => {
  const stale = await makeLedger("stale");
  const staleWriter = await createConfirmedTransactionWriter({ ledgerWorkspace: stale.workspace });
  await staleWriter.preview(tx("2026-09-01", "午餐", [{ account: "Expenses:C-餐饮", amount: "12 CNY" }, { account: "Assets:C-钱包" }]));
  await appendFile(join(stale.ledger, "accounts.beancount"), "2026-01-01 open Assets:C-追加\n", "utf8");
  await assert.rejects(staleWriter.commit(), (error: unknown) => error instanceof FinanceError && error.code === "preview_stale");
  assert.equal(await readFile(stale.transactions, "utf8"), EXISTING);

  const nextYear = await makeLedger("new-year");
  const nextYearWriter = await createConfirmedTransactionWriter({ ledgerWorkspace: nextYear.workspace });
  const preview = await nextYearWriter.preview(tx("2027-01-02", "新年午餐", [{ account: "Expenses:C-餐饮", amount: "8 CNY" }, { account: "Assets:C-钱包" }]));
  assert.equal(preview.createsFile, true);
  await nextYearWriter.commit();
  const engine = createLedgerEngine({ ledgerWorkspace: nextYear.workspace });
  assert.deepEqual(await engine.validateJournal(), { valid: true });
  const register = await engine.queryRegister({ begin: "2027-01-02", end: "2027-01-03" });
  assert.deepEqual(register.transactions.map((entry) => entry.narration), ["新年午餐"]);
});

test("预览后新增 include 命中的年度文件时以 preview_stale 拒绝", { skip }, async () => {
  const { workspace, ledger, transactions } = await makeLedger("include-set");
  const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: workspace });
  await writer.preview(tx("2026-09-01", "午餐", [{ account: "Expenses:C-餐饮", amount: "12 CNY" }, { account: "Assets:C-钱包" }]));
  await writeFile(join(ledger, "transactions", "2030.beancount"), "");
  await assert.rejects(writer.commit(), (error: unknown) => error instanceof FinanceError && error.code === "preview_stale");
  assert.equal(await readFile(transactions, "utf8"), EXISTING);
});

test("提交时对保存的规范文本重新校验，校验失败时零写入", { skip }, async () => {
  const { workspace, transactions } = await makeLedger("revalidate");
  const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: workspace });
  const preview = await writer.preview(tx("2026-09-01", "午餐", [{ account: "Expenses:C-餐饮", amount: "12 CNY" }, { account: "Assets:C-钱包" }]));
  assert.equal(preview.validation, "passed");
  const result = await writer.commit();
  assert.equal(result.transactionText, preview.transactionText);
  assert.equal(await readFile(transactions, "utf8"), `${EXISTING.trimEnd()}\n\n${preview.transactionText}`);
});
