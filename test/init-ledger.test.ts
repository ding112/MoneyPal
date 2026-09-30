import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { initializeLedger, planLedgerInitialization } from "../src/init-ledger.js";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "moneypal-init-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("初始化账本工作区的固定布局", async () => {
  const workspace = join(root, "new-ledger");

  const ledger = await initializeLedger({ ledgerWorkspace: workspace, year: 2030 });

  assert.equal(ledger, join(workspace, "default"));
  assert.equal(
    await readFile(join(ledger, "main.beancount"), "utf8"),
    'include "accounts.beancount"\ninclude "transactions/*.beancount"\n',
  );
  assert.match(await readFile(join(ledger, "accounts.beancount"), "utf8"), /2030-01-01 commodity CNY/u);
  assert.match(await readFile(join(ledger, "accounts.beancount"), "utf8"), /2030-01-01 open Assets:C-现金/u);
  assert.match(await readFile(join(ledger, "accounts.beancount"), "utf8"), /2030-01-01 open Liabilities:C-信用卡/u);
  assert.match(await readFile(join(ledger, "accounts.beancount"), "utf8"), /2030-01-01 open Equity:C-期初余额/u);
  assert.match(await readFile(join(ledger, "accounts.beancount"), "utf8"), /2030-01-01 open Expenses:C-餐饮/u);
  assert.match(await readFile(join(ledger, "accounts.beancount"), "utf8"), /2030-01-01 open Income:C-工资/u);
  assert.equal(await readFile(join(ledger, "transactions", "2030.beancount"), "utf8"), "");
});

test("已有 default 目录时拒绝覆盖", async () => {
  const workspace = join(root, "existing-ledger");
  const ledger = await initializeLedger({ ledgerWorkspace: workspace, year: 2030 });
  const accounts = join(ledger, "accounts.beancount");
  await writeFile(accounts, "2030-01-01 open Assets:Existing\n", "utf8");

  await assert.rejects(
    initializeLedger({ ledgerWorkspace: workspace, year: 2031 }),
    /为避免覆盖/u,
  );
  assert.equal(await readFile(accounts, "utf8"), "2030-01-01 open Assets:Existing\n");
  await assert.rejects(stat(join(ledger, "transactions", "2031.beancount")));
});

test("拒绝无效初始化年份", async () => {
  await assert.rejects(
    initializeLedger({ ledgerWorkspace: join(root, "invalid-year"), year: 99 }),
    /四位整数/u,
  );
});

test("初始化计划复用固定模板，并在确认前拒绝已有账本", async () => {
  const workspace = join(root, "planned-ledger");
  assert.deepEqual(await planLedgerInitialization({ ledgerWorkspace: workspace, year: 2030 }), {
    ledgerDirectory: "default",
    year: 2030,
    files: ["default/accounts.beancount", "default/transactions/2030.beancount", "default/main.beancount"],
    accounts: ["Assets:C-现金", "Liabilities:C-信用卡", "Equity:C-期初余额", "Expenses:C-餐饮", "Income:C-工资"],
  });
  await initializeLedger({ ledgerWorkspace: workspace, year: 2030 });
  await assert.rejects(
    planLedgerInitialization({ ledgerWorkspace: workspace, year: 2030 }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ledger_already_initialized",
  );
});

test("并发初始化只允许一个调用创建账本", async () => {
  const workspace = join(root, "concurrent-ledger");
  const results = await Promise.allSettled([
    initializeLedger({ ledgerWorkspace: workspace, year: 2030 }),
    initializeLedger({ ledgerWorkspace: workspace, year: 2030 }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(await readFile(join(workspace, "default", "main.beancount"), "utf8"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
});
