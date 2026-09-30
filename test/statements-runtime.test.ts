import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createLedgerEngine } from "../src/finance/engine.js";
import { FinanceError } from "../src/finance/errors.js";
import type { BalanceSheet, IncomeStatement } from "../src/finance/types.js";
import { runtimeSkipReason } from "./runtime-fixtures.js";

/** 本文件在真实 MoneyPal 运行时上验证损益表与资产负债表的 Beancount 语义；未安装时整体跳过。 */
const skip = await runtimeSkipReason();

/**
 * 固定账本 A：无成本、无结汇的跨年多币种账本。
 * - 跨年：2025 期初 + 收入/支出；2026 活动；closed 账户 Expenses:C-旧项目。
 * - 子账户：Assets:C-现金:C-零钱、Expenses:C-餐饮:C-午餐。
 * - 未启用账户：Income:C-利息 只声明不记账。
 * - 多币种：CNY 与 USD 各自平衡，保证每商品恒等关系可直接验证。
 */
const FIXTURE_A_ACCOUNTS = `2025-01-01 commodity CNY
2025-01-01 open Assets:C-现金
2025-01-01 open Assets:C-现金:C-零钱
2025-01-01 open Assets:C-美元
2025-01-01 open Liabilities:C-信用卡
2025-01-01 open Equity:C-期初余额
2025-01-01 open Income:C-工资
2025-01-01 open Income:C-利息
2025-01-01 open Expenses:C-餐饮
2025-01-01 open Expenses:C-餐饮:C-午餐
2025-01-01 open Expenses:C-旧项目
`;
const FIXTURE_A_TRANSACTIONS = `2025-01-02 * "期初" "开户"
  Assets:C-现金      500 CNY
  Equity:C-期初余额  -500 CNY

2025-06-01 * "雇主" "工资"
  Assets:C-现金      300 CNY
  Income:C-工资     -300 CNY

2025-06-02 * "旧账" "旧项目支出"
  Expenses:C-旧项目  50 CNY
  Assets:C-现金     -50 CNY

2025-12-31 close Expenses:C-旧项目

2026-02-01 * "雇主" "工资"
  Assets:C-现金      300 CNY
  Income:C-工资     -300 CNY

2026-02-02 * "超市" "午餐"
  Expenses:C-餐饮:C-午餐  20 CNY
  Assets:C-现金          -20 CNY

2026-02-03 * "银行" "信用卡还款"
  Liabilities:C-信用卡   -100 CNY
  Assets:C-现金          100 CNY

2026-02-05 * "自己" "转零钱"
  Assets:C-现金:C-零钱   0.2 CNY
  Assets:C-现金          -0.2 CNY

2026-03-01 * "店家" "办公采购"
  Expenses:C-餐饮  40 USD
  Assets:C-美元    -40 USD
`;

/**
 * 固定账本 B：带成本与结汇的账本，用于覆盖 CLOSE/CLEAR 转换产生的权益账户。
 * 成本/汇兑结构使 units 口径下两侧不能直接比较，因此本账本只断言结构，
 * 不要求每商品恒等（见决策票 04「不保证两侧可以直接比较，但不隐式估值或伪造平衡」）。
 */
const FIXTURE_B_ACCOUNTS = `2025-01-01 commodity CNY
2025-01-01 open Assets:C-现金
2025-01-01 open Assets:C-美元
2025-01-01 open Assets:C-股票
2025-01-01 open Liabilities:C-信用卡
2025-01-01 open Equity:C-期初余额
2025-01-01 open Income:C-工资
2025-01-01 open Expenses:C-餐饮
2025-01-01 open Expenses:C-旧项目
`;
const FIXTURE_B_TRANSACTIONS = `2025-01-02 * "期初" "开户"
  Assets:C-现金      500 CNY
  Equity:C-期初余额  -500 CNY

2025-06-01 * "雇主" "工资"
  Assets:C-现金      300 CNY
  Income:C-工资     -300 CNY

2025-06-02 * "旧账" "旧项目支出"
  Expenses:C-旧项目  50 CNY
  Assets:C-现金     -50 CNY

2025-12-31 close Expenses:C-旧项目

2026-02-01 * "雇主" "工资"
  Assets:C-现金      300 CNY
  Income:C-工资     -300 CNY

2026-02-02 * "超市" "午餐"
  Expenses:C-餐饮      20 CNY
  Assets:C-现金       -20 CNY

2026-02-03 * "银行" "信用卡还款"
  Liabilities:C-信用卡   -100 CNY
  Assets:C-现金          100 CNY

2026-03-01 * "店家" "办公采购"
  Expenses:C-餐饮  40 USD
  Assets:C-美元    -40 USD

2026-03-02 * "券商" "买入股票"
  Assets:C-股票     10 STOCK {15 USD, 2026-03-02}
  Assets:C-美元    -150 USD

2026-03-03 * "银行" "结汇"
  Assets:C-美元    20 CNY @ 0.1 USD
  Assets:C-美元    -2 USD
`;

let workspaceA: string;
let workspaceB: string;
let workspaces: string[] = [];

async function fixtureWorkspace(name: string, accounts: string, transactions: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `moneypal-statements-${name}-`));
  workspaces.push(workspace);
  const ledger = join(workspace, "default");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n', "utf8");
  await writeFile(join(ledger, "accounts.beancount"), accounts, "utf8");
  await writeFile(join(ledger, "transactions", "2026.beancount"), transactions, "utf8");
  return workspace;
}

before(async () => {
  if (skip) return;
  workspaceA = await fixtureWorkspace("a", FIXTURE_A_ACCOUNTS, FIXTURE_A_TRANSACTIONS);
  workspaceB = await fixtureWorkspace("b", FIXTURE_B_ACCOUNTS, FIXTURE_B_TRANSACTIONS);
});

after(async () => {
  if (skip) return;
  await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
});

function engine(workspace: string) {
  return createLedgerEngine({ ledgerWorkspace: workspace });
}

/** 资产负债表按商品逐项断言资产 = 负债 + 权益，验证会计恒等关系可核验。 */
function assertIdentity(balanceSheet: BalanceSheet): void {
  assert.deepEqual(balanceSheet.totals.liabilitiesAndEquity, balanceSheet.totals.assets);
}

test("损益表只按 Income 与 Expenses 分类，子账户平铺、跨年与已关闭账户按期间过滤", { skip }, async () => {
  const result = await engine(workspaceA).getIncomeStatement({ begin: "2026-01-01", end: "2027-01-01" });
  assert.deepEqual(result, {
    range: { begin: "2026-01-01", end: "2027-01-01" },
    income: {
      accounts: [{ account: "Income:C-工资", amounts: [{ commodity: "CNY", quantity: "300" }] }],
      totals: [{ commodity: "CNY", quantity: "300" }],
    },
    expenses: {
      accounts: [
        { account: "Expenses:C-餐饮", amounts: [{ commodity: "USD", quantity: "40" }] },
        { account: "Expenses:C-餐饮:C-午餐", amounts: [{ commodity: "CNY", quantity: "20" }] },
      ],
      totals: [{ commodity: "CNY", quantity: "20" }, { commodity: "USD", quantity: "40" }],
    },
    netIncome: [{ commodity: "CNY", quantity: "280" }, { commodity: "USD", quantity: "-40" }],
  } satisfies IncomeStatement);

  // 只声明未记账的账户（未启用账户）不产生报表行。
  assert.ok(!JSON.stringify(result).includes("Income:C-利息"));

  // 跨年：2025 年报表包含已关闭账户在关闭前的支出，2026 年报表不包含。
  const year2025 = await engine(workspaceA).getIncomeStatement({ begin: "2025-01-01", end: "2026-01-01" });
  assert.deepEqual(year2025.expenses.accounts, [{ account: "Expenses:C-旧项目", amounts: [{ commodity: "CNY", quantity: "50" }] }]);
  assert.deepEqual(year2025.netIncome, [{ commodity: "CNY", quantity: "250" }]);

  // 日期边界 begin 含、end 不含：end=03-01 的交易不计入 2 月损益。
  const february = await engine(workspaceA).getIncomeStatement({ begin: "2026-02-01", end: "2026-03-01" });
  assert.deepEqual(february, {
    range: { begin: "2026-02-01", end: "2026-03-01" },
    income: { accounts: [{ account: "Income:C-工资", amounts: [{ commodity: "CNY", quantity: "300" }] }], totals: [{ commodity: "CNY", quantity: "300" }] },
    expenses: { accounts: [{ account: "Expenses:C-餐饮:C-午餐", amounts: [{ commodity: "CNY", quantity: "20" }] }], totals: [{ commodity: "CNY", quantity: "20" }] },
    netIncome: [{ commodity: "CNY", quantity: "280" }],
  });
});

test("损益表空期间与 engine 层逆序区间返回空分区，不隐式替换时间", { skip }, async () => {
  const empty = await engine(workspaceA).getIncomeStatement({ begin: "2026-04-01", end: "2026-05-01" });
  assert.deepEqual(empty, { range: { begin: "2026-04-01", end: "2026-05-01" }, income: { accounts: [], totals: [] }, expenses: { accounts: [], totals: [] }, netIncome: [] });

  // begin >= end 在宿主契约层是 invalid_request；账本引擎层与余额/流水一致地返回空结果。
  const inverted = await engine(workspaceA).getIncomeStatement({ begin: "2026-05-01", end: "2026-04-01" });
  assert.deepEqual(inverted.income.accounts, []);
  assert.deepEqual(inverted.expenses.accounts, []);
});

test("资产负债表期末余额满足会计恒等关系并保留多币种 Decimal 字符串", { skip }, async () => {
  const full = await engine(workspaceA).getBalanceSheet({ begin: "2026-01-01", end: "2027-01-01" });
  assert.deepEqual(full, {
    range: { begin: "2026-01-01", end: "2027-01-01" },
    assets: {
      accounts: [
        { account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1129.8" }] },
        { account: "Assets:C-现金:C-零钱", amounts: [{ commodity: "CNY", quantity: "0.2" }] },
        { account: "Assets:C-美元", amounts: [{ commodity: "USD", quantity: "-40" }] },
      ],
      totals: [{ commodity: "CNY", quantity: "1130" }, { commodity: "USD", quantity: "-40" }],
    },
    liabilities: {
      accounts: [{ account: "Liabilities:C-信用卡", amounts: [{ commodity: "CNY", quantity: "100" }] }],
      totals: [{ commodity: "CNY", quantity: "100" }],
    },
    equity: {
      accounts: [
        { account: "Equity:C-期初余额", amounts: [{ commodity: "CNY", quantity: "500" }] },
        { account: "Equity:Earnings:Current", amounts: [{ commodity: "CNY", quantity: "280" }, { commodity: "USD", quantity: "-40" }] },
        { account: "Equity:Earnings:Previous", amounts: [{ commodity: "CNY", quantity: "250" }] },
      ],
      totals: [{ commodity: "CNY", quantity: "1030" }, { commodity: "USD", quantity: "-40" }],
    },
    totals: { assets: [{ commodity: "CNY", quantity: "1130" }, { commodity: "USD", quantity: "-40" }], liabilitiesAndEquity: [{ commodity: "CNY", quantity: "1130" }, { commodity: "USD", quantity: "-40" }] },
  } satisfies BalanceSheet);
  assertIdentity(full);

  // 截止单边界：end 单独给出时全部历史净损益计入本期收益。
  const endOnly = await engine(workspaceA).getBalanceSheet({ end: "2027-01-01" });
  assert.deepEqual(endOnly.equity.accounts.map(({ account }) => account), ["Equity:C-期初余额", "Equity:Earnings:Current"]);
  assert.deepEqual(endOnly.equity.totals, [{ commodity: "CNY", quantity: "1030" }, { commodity: "USD", quantity: "-40" }]);
  assertIdentity(endOnly);

  // end=null 时不执行 CLOSE/CLEAR：不伪造期末本期收益账户。
  const beginOnly = await engine(workspaceA).getBalanceSheet({ begin: "2026-01-01" });
  assert.deepEqual(beginOnly.equity.accounts.map(({ account }) => account), ["Equity:C-期初余额", "Equity:Earnings:Previous"]);
  assert.notDeepEqual(beginOnly.totals.assets, beginOnly.totals.liabilitiesAndEquity);

  const none = await engine(workspaceA).getBalanceSheet({});
  assert.deepEqual(none.equity.accounts.map(({ account }) => account), ["Equity:C-期初余额"]);
  assert.notDeepEqual(none.totals.assets, none.totals.liabilitiesAndEquity);

  // 月份期末：end 排他，03-01 的 USD 交易不计入，期初与前期收益保留。
  const month = await engine(workspaceA).getBalanceSheet({ begin: "2026-02-01", end: "2026-03-01" });
  assert.deepEqual(month.totals, { assets: [{ commodity: "CNY", quantity: "1130" }], liabilitiesAndEquity: [{ commodity: "CNY", quantity: "1130" }] });
  assertIdentity(month);
});

test("资产负债表保留 OPEN/CLOSE/CLEAR 转换产生的权益账户准确名称", { skip }, async () => {
  const result = await engine(workspaceB).getBalanceSheet({ begin: "2026-01-01", end: "2027-01-01" });
  assert.deepEqual(result.assets, {
    accounts: [
      { account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1130" }] },
      { account: "Assets:C-美元", amounts: [{ commodity: "CNY", quantity: "20" }, { commodity: "USD", quantity: "-192" }] },
      { account: "Assets:C-股票", amounts: [{ commodity: "STOCK", quantity: "10" }] },
    ],
    totals: [{ commodity: "CNY", quantity: "1150" }, { commodity: "STOCK", quantity: "10" }, { commodity: "USD", quantity: "-192" }],
  });
  assert.deepEqual(result.equity.accounts, [
    { account: "Equity:C-期初余额", amounts: [{ commodity: "CNY", quantity: "500" }] },
    { account: "Equity:Conversions:Current", amounts: [{ commodity: "CNY", quantity: "20" }, { commodity: "USD", quantity: "-2" }] },
    { account: "Equity:Earnings:Current", amounts: [{ commodity: "CNY", quantity: "280" }, { commodity: "USD", quantity: "-40" }] },
    { account: "Equity:Earnings:Previous", amounts: [{ commodity: "CNY", quantity: "250" }] },
  ]);
  // 成本/汇兑结构下 units 两侧按商品存在如实差额（股票成本 150 USD），但不伪造平衡。
  assert.notDeepEqual(result.totals.assets, result.totals.liabilitiesAndEquity);
  const assetByCommodity = new Map(result.totals.assets.map((amount) => [amount.commodity, amount.quantity]));
  const equityByCommodity = new Map(result.totals.liabilitiesAndEquity.map((amount) => [amount.commodity, amount.quantity]));
  assert.equal(assetByCommodity.get("STOCK"), "10");
  assert.equal(equityByCommodity.get("STOCK"), undefined);
  assert.equal(assetByCommodity.get("CNY"), equityByCommodity.get("CNY"));
});

test("空账本与空期间下资产负债表分区与合计为空数组", { skip }, async () => {
  const empty = await fixtureWorkspace("empty", "2026-01-01 commodity CNY\n2026-01-01 open Assets:C-现金\n2026-01-01 open Equity:C-期初余额\n", "");
  const result = await engine(empty).getBalanceSheet({ begin: "2026-01-01", end: "2027-01-01" });
  assert.deepEqual(result, {
    range: { begin: "2026-01-01", end: "2027-01-01" },
    assets: { accounts: [], totals: [] },
    liabilities: { accounts: [], totals: [] },
    equity: { accounts: [], totals: [] },
    totals: { assets: [], liabilitiesAndEquity: [] },
  });

  const emptyIncome = await engine(empty).getIncomeStatement({});
  assert.deepEqual(emptyIncome, { range: { begin: null, end: null }, income: { accounts: [], totals: [] }, expenses: { accounts: [], totals: [] }, netIncome: [] });
});

test("直接调用账本引擎时非法报表日期被净化为 invalid_request", { skip }, async () => {
  await assert.rejects(engine(workspaceA).getBalanceSheet({ begin: "not-a-date" }), (error: unknown) => {
    assert.ok(error instanceof FinanceError);
    assert.equal(error.code, "invalid_request");
    assert.equal(error.message, "日期参数不是合法的 YYYY-MM-DD 绝对日期。");
    assert.doesNotMatch(JSON.stringify(error), /Traceback|ValueError|fromisoformat/u);
    return true;
  });
});
