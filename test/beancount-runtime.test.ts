import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createLedgerEngine } from "../src/finance/engine.js";
import { FinanceError } from "../src/finance/errors.js";
import { inspectRuntime } from "../src/finance/runtime.js";
import { initializeLedger } from "../src/init-ledger.js";

/** 本文件在真实 MoneyPal 运行时上验证账本引擎语义；未安装时整体跳过，保持其余套件可离线运行。 */
const runtime = await inspectRuntime().catch(() => undefined);
const skip = runtime?.available ? false : "未检测到可用的 MoneyPal 运行时；请先执行 setup-runtime。";

let workspace: string;

const FIXTURE_TRANSACTIONS = `2026-01-01 * "期初" "开户"
  Assets:C-现金             0.1 CNY
  Assets:C-现金             10000000000000000 USD
  Equity:C-期初余额         -0.1 CNY
  Equity:C-期初余额         -10000000000000000 USD

2026-01-02 * "零钱" "存入零钱"
  Assets:C-现金:C-零钱      0.2 CNY
  Equity:C-期初余额         -0.2 CNY

2026-01-05 * "超市" "购物" #food #lunch ^receipt-1
  receipt: "A-1"
  scale: 12.50
  empty-meta:
  Expenses:C-餐饮    12.50 CNY
    note: "含税"
  Assets:C-现金      -12.50 CNY

2026-01-05 * "加油站" "加油"
  Expenses:C-餐饮    20 CNY
  Assets:C-现金      -20 CNY

2026-01-08 * "券商" "买入股票"
  Assets:C-股票      10 STOCK {12 CNY, 2026-01-02, "lot-a"} @ 15 CNY
  Assets:C-现金      -120 CNY

2026-01-08 * "银行" "结汇"
  Assets:C-现金      30 CNY @ 0.2 STOCK
  Assets:C-股票      -6 STOCK

2026-01-10 * "测试" "零金额与 posting flag"
  Expenses:C-餐饮    0 CNY
  ! Assets:C-现金    -0 CNY
`;

before(async () => {
  if (skip) return;
  workspace = await mkdtemp(join(tmpdir(), "moneypal-beancount-runtime-"));
  const ledger = await initializeLedger({ ledgerWorkspace: workspace, year: 2026 });
  await appendFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:C-现金:C-零钱\n2026-01-01 open Assets:C-股票\n", "utf8");
  await writeFile(join(ledger, "transactions", "2026.beancount"), FIXTURE_TRANSACTIONS, "utf8");
});

after(async () => {
  if (skip) return;
  await rm(workspace, { recursive: true, force: true });
});

test("账本引擎以 Beancount 语义返回声明账户和精确多币种余额", { skip }, async () => {
  const engine = createLedgerEngine({ ledgerWorkspace: workspace });

  assert.deepEqual(await engine.listAccounts(), {
    accounts: ["Assets:C-现金", "Assets:C-现金:C-零钱", "Assets:C-股票", "Equity:C-期初余额", "Expenses:C-餐饮", "Income:C-工资", "Liabilities:C-信用卡"],
  });

  assert.deepEqual(await engine.getBalance({ account: "Assets:C-现金", end: "2026-01-03" }), {
    range: { begin: null, end: "2026-01-03" },
    accounts: [
      { account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "0.1" }, { commodity: "USD", quantity: "10000000000000000" }] },
      { account: "Assets:C-现金:C-零钱", amounts: [{ commodity: "CNY", quantity: "0.2" }] },
    ],
    totals: [{ commodity: "CNY", quantity: "0.3" }, { commodity: "USD", quantity: "10000000000000000" }],
  });

  assert.deepEqual(await engine.getBalance({ end: "2026-01-03" }), {
    range: { begin: null, end: "2026-01-03" },
    accounts: [
      { account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "0.1" }, { commodity: "USD", quantity: "10000000000000000" }] },
      { account: "Assets:C-现金:C-零钱", amounts: [{ commodity: "CNY", quantity: "0.2" }] },
      { account: "Equity:C-期初余额", amounts: [{ commodity: "CNY", quantity: "-0.3" }, { commodity: "USD", quantity: "-10000000000000000" }] },
    ],
    totals: [],
  });
});

test("完整流水返回交易与 posting 的全部领域字段，不含引擎内部 metadata", { skip }, async () => {
  const engine = createLedgerEngine({ ledgerWorkspace: workspace });

  assert.deepEqual(await engine.queryRegister({ begin: "2026-01-05", end: "2026-01-06" }), {
    range: { begin: "2026-01-05", end: "2026-01-06" },
    truncated: false,
    transactions: [{
      date: "2026-01-05",
      flag: "*",
      payee: "超市",
      narration: "购物",
      tags: ["food", "lunch"],
      links: ["receipt-1"],
      metadata: { receipt: "A-1", scale: "12.5", "empty-meta": null },
      postings: [
        { account: "Expenses:C-餐饮", units: { commodity: "CNY", quantity: "12.5" }, cost: null, price: null, flag: null, metadata: { note: "含税" } },
        { account: "Assets:C-现金", units: { commodity: "CNY", quantity: "-12.5" }, cost: null, price: null, flag: null, metadata: {} },
      ],
    }, {
      date: "2026-01-05",
      flag: "*",
      payee: "加油站",
      narration: "加油",
      tags: [],
      links: [],
      metadata: {},
      postings: [
        { account: "Expenses:C-餐饮", units: { commodity: "CNY", quantity: "20" }, cost: null, price: null, flag: null, metadata: {} },
        { account: "Assets:C-现金", units: { commodity: "CNY", quantity: "-20" }, cost: null, price: null, flag: null, metadata: {} },
      ],
    }],
  });

  const stock = await engine.queryRegister({ begin: "2026-01-08", end: "2026-01-09" });
  assert.deepEqual(stock.transactions.map((transaction) => transaction.payee), ["券商", "银行"]);
  assert.deepEqual(stock.transactions[0]!.postings[0], {
    account: "Assets:C-股票",
    units: { commodity: "STOCK", quantity: "10" },
    cost: { currency: "CNY", number: "12", date: "2026-01-02", label: "lot-a" },
    price: { commodity: "CNY", quantity: "15" },
    flag: null,
    metadata: {},
  });
  assert.deepEqual(stock.transactions[1]!.postings[0]!.price, { commodity: "STOCK", quantity: "0.2" });

  const zero = await engine.queryRegister({ begin: "2026-01-10", end: "2026-01-11" });
  assert.deepEqual(zero.transactions[0]!.postings, [
    { account: "Expenses:C-餐饮", units: { commodity: "CNY", quantity: "0" }, cost: null, price: null, flag: null, metadata: {} },
    { account: "Assets:C-现金", units: { commodity: "CNY", quantity: "0" }, cost: null, price: null, flag: "!", metadata: {} },
  ]);
});

test("流水过滤按账户子树、日期区间和大小写敏感文本组合", { skip }, async () => {
  const engine = createLedgerEngine({ ledgerWorkspace: workspace });
  const narrations = async (query: Parameters<typeof engine.queryRegister>[0]) =>
    (await engine.queryRegister(query)).transactions.map((transaction) => transaction.narration);

  // 账户过滤命中任一 posting 时整笔交易只返回一次，并保留全部 postings。
  const stock = await engine.queryRegister({ account: "Assets:C-股票" });
  assert.deepEqual(stock.transactions.map((transaction) => transaction.payee), ["券商", "银行"]);
  assert.equal(stock.transactions[0]!.postings.length, 2);
  assert.deepEqual(await narrations({ account: "Assets:C-现金:C-零钱" }), ["存入零钱"]);
  assert.equal((await engine.queryRegister({ account: "Assets" })).transactions.length, 7);

  // 文本匹配 payee 或 narration 的大小写敏感子串，不命中 tags 或 links。
  assert.deepEqual(await narrations({ text: "加油" }), ["加油"]);
  assert.deepEqual(await narrations({ text: "超市" }), ["购物"]);
  assert.deepEqual(await narrations({ text: "LUNCH" }), []);
  assert.deepEqual(await narrations({ text: "股票" }), ["买入股票"]);
  assert.deepEqual(await narrations({ text: "food" }), []);
  assert.deepEqual(await narrations({ text: "receipt-1" }), []);

  // 日期区间 begin 含、end 排他。
  assert.deepEqual(await narrations({ begin: "2026-01-05", end: "2026-01-08" }), ["购物", "加油"]);
  assert.deepEqual(await narrations({ begin: "2026-01-08", end: "2026-01-09" }), ["买入股票", "结汇"]);

  // 过滤条件取交集。
  assert.deepEqual(await narrations({ account: "Assets:C-股票", text: "结汇" }), ["结汇"]);
  assert.deepEqual(await narrations({ account: "Assets:C-股票", text: "加油" }), []);
  assert.deepEqual(await narrations({ account: "Assets:C-股票", begin: "2026-01-08", end: "2026-01-09", text: "结汇" }), ["结汇"]);
});

test("流水保序且空结果与截断可区分", { skip }, async () => {
  const engine = createLedgerEngine({ ledgerWorkspace: workspace });

  const all = await engine.queryRegister({});
  assert.deepEqual(all.transactions.map((transaction) => transaction.narration),
    ["开户", "存入零钱", "购物", "加油", "买入股票", "结汇", "零金额与 posting flag"]);
  // 同日交易保持交易文件顺序，posting 保持指令顺序。
  const sameDay = await engine.queryRegister({ begin: "2026-01-05", end: "2026-01-06" });
  assert.deepEqual(sameDay.transactions.map((transaction) => transaction.payee), ["超市", "加油站"]);

  const limited = await engine.queryRegister({ limit: 1 });
  assert.deepEqual(limited.transactions.map((transaction) => transaction.narration), ["开户"]);
  assert.equal(limited.truncated, true);
  assert.deepEqual((await engine.queryRegister({ limit: 7 })).truncated, false);
  assert.deepEqual((await engine.queryRegister({ begin: "2026-01-05", end: "2026-01-08", limit: 2 })).truncated, false);
  assert.deepEqual((await engine.queryRegister({ text: "不存在" })), { range: { begin: null, end: null }, truncated: false, transactions: [] });
});

test("流水查询错误经公共错误体系返回，不暴露 Python 细节", { skip }, async () => {
  const broken = await mkdtemp(join(tmpdir(), "moneypal-broken-ledger-"));
  try {
    const ledger = await initializeLedger({ ledgerWorkspace: broken, year: 2026 });
    await writeFile(join(ledger, "accounts.beancount"), "commodity CNY\n", { flag: "w", encoding: "utf8" });
    const engine = createLedgerEngine({ ledgerWorkspace: broken });

    await assert.rejects(engine.queryRegister({ begin: "2026-01-01", end: "2026-02-01" }), (error: unknown) => {
      assert.ok(error instanceof FinanceError);
      assert.equal(error.code, "journal_invalid");
      assert.equal(error.message, "正式账本未通过 Beancount 校验；请修复后重试。");
      assert.deepEqual(error.diagnostics, [{
        severity: "error",
        location: { file: "accounts.beancount", line: 1 },
        message: "账本存在 Beancount 语法或会计校验错误。",
        action: "请根据位置修复该指令后重新验证。",
      }]);
      assert.doesNotMatch(JSON.stringify(error), /Traceback|Decimal\(|__main__/u);
      return true;
    });
  } finally {
    await rm(broken, { recursive: true, force: true });
  }
});
