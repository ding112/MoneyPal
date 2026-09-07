import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { FinanceError } from "../src/finance/errors.js";
import { createConfirmedTransactionWriter } from "../src/finance/write.js";

let root: string;

before(async () => { root = await mkdtemp(join(tmpdir(), "moneypal-confirmed-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

const tx = (description = "午餐") => ({ date: "2026-08-25", description, postings: [{ account: "Expenses:Food", amount: "12 CNY" }, { account: "Assets:Wallet" }] });

async function workspace(name: string): Promise<{ workspace: string; ledger: string; transactions: string }> {
  const workspace = join(root, name);
  const ledger = join(workspace, "default");
  const transactions = join(ledger, "transactions", "2026.beancount");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  await writeFile(transactions, "");
  return { workspace, ledger, transactions };
}

/** 托管运行时假脚本：preview 返回固定规范文本与真实加载文件列表，validate_candidates 可按环境变量失败或延迟。 */
async function fakeRuntime(name: string, ledger: string): Promise<string> {
  const loadedFiles = [join(ledger, "main.beancount"), join(ledger, "accounts.beancount"), join(ledger, "transactions", "2026.beancount")];
  const preview = {
    validation: "passed",
    transactions: ['2026-08-25 * "午餐"\n  Expenses:Food   12 CNY\n  Assets:Wallet  -12 CNY\n'],
    transactionText: '2026-08-25 * "午餐"\n  Expenses:Food   12 CNY\n  Assets:Wallet  -12 CNY\n',
    amountSummary: [{ commodity: "CNY", income: "0", expenses: "12", netIncome: "-12" }],
    duplicateWarnings: [],
    loadedFiles,
  };
  const runtime = join(root, `${name}.sh`);
  await writeFile(runtime, `#!/bin/sh
request=$(cat)
case "$request" in
  *'"operation":"probe"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"pythonVersion":"3.11.0","beancountVersion":"3.2.3","beanqueryVersion":"0.2.0","beancountAvailable":true}}' ;;
  *'"operation":"preview"'*) printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime: { python: "3.11.11", beancount: "3.2.3", beanquery: "0.2.0" }, ok: true, result: preview })}' ;;
  *'"operation":"validate_candidates"'*)
    [ -n "$MONEYPAL_FAKE_SLEEP" ] && sleep "$MONEYPAL_FAKE_SLEEP"
    if [ "$MONEYPAL_FAKE_VALIDATE_FAIL" = "1" ]; then printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":false,"error":{"code":"invalid_transaction_batch"}}'; else printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime: { python: "3.11.11", beancount: "3.2.3", beanquery: "0.2.0" }, ok: true, result: { valid: true, loadedFiles } })}'; fi ;;
  *) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"valid":true}}' ;;
esac
`, { mode: 0o700 });
  await chmod(runtime, 0o700);
  return runtime;
}

async function withEnv(entries: Record<string, string | undefined>, action: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { await action(); } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("预览后账本变化或锁冲突时零写入，且失败后批次作废", async () => {
  const first = await workspace("stale");
  const second = await workspace("locked");
  const runtime = await fakeRuntime("stale-lock", first.ledger);
  const lockedRuntime = await fakeRuntime("locked-lock", second.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: first.workspace });
    await writer.preview(tx());
    await writeFile(join(first.ledger, "accounts.beancount"), "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n; changed\n");
    await assert.rejects(writer.commit(), (error: unknown) => error instanceof FinanceError && error.code === "preview_stale");
    assert.equal(await readFile(first.transactions, "utf8"), "");
  });
  await withEnv({ MONEYPAL_PYTHON: lockedRuntime }, async () => {
    const lockedWriter = await createConfirmedTransactionWriter({ ledgerWorkspace: second.workspace });
    await lockedWriter.preview(tx());
    const lock = await open(join(second.ledger, ".moneypal-write.lock"), "wx");
    try {
      await assert.rejects(lockedWriter.commit(), (error: unknown) => error instanceof FinanceError && error.code === "ledger_locked");
      assert.equal(await readFile(second.transactions, "utf8"), "");
    } finally {
      await lock.close();
      await rm(join(second.ledger, ".moneypal-write.lock"));
    }
    // commit 只允许一次：失败后批次已被消费，必须重新预览。
    await assert.rejects(lockedWriter.commit(), (error: unknown) => error instanceof FinanceError && error.code === "invalid_transaction_batch");
  });
});

test("未预览直接提交被拒，且 commit 成功后批次不可复用", async () => {
  const setup = await workspace("consume-workspace");
  const runtime = await fakeRuntime("consume", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    await assert.rejects(writer.commit(), (error: unknown) => error instanceof FinanceError && error.code === "invalid_transaction_batch");
    await writer.preview(tx());
    await writer.commit();
    await assert.rejects(writer.commit(), (error: unknown) => error instanceof FinanceError && error.code === "invalid_transaction_batch");
  });
});

test("预览文本逐字节等于最终写入文本，确认后一次性原子写入", async () => {
  const setup = await workspace("batch");
  const runtime = await fakeRuntime("byte-identical", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    const preview = await writer.preview(tx());
    assert.equal(preview.targetFile, "transactions/2026.beancount");
    assert.equal(preview.createsFile, false);
    assert.equal(preview.validation, "passed");
    assert.deepEqual(preview.transactions, ['2026-08-25 * "午餐"\n  Expenses:Food   12 CNY\n  Assets:Wallet  -12 CNY\n']);
    assert.deepEqual(preview.amountSummary, [{ commodity: "CNY", income: "0", expenses: "12", netIncome: "-12" }]);
    assert.deepEqual(preview.duplicateWarnings, []);
    assert.equal(await readFile(setup.transactions, "utf8"), "");

    const result = await writer.commit();
    assert.equal(result.targetFile, "transactions/2026.beancount");
    assert.equal(result.transactionText, preview.transactionText);
    assert.equal(await readFile(setup.transactions, "utf8"), preview.transactionText);
  });
});

test("追加时对无换行、单换行和已有空行都只保留一个空行分隔", async () => {
  for (const [name, existing] of [["none", "; header"], ["one", "; header\n"], ["blank", "; header\n\n"]] as const) {
    const setup = await workspace(`separator-${name}`);
    await writeFile(setup.transactions, existing);
    const runtime = await fakeRuntime(`separator-${name}`, setup.ledger);
    await withEnv({ MONEYPAL_PYTHON: runtime }, async () => {
      const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
      const preview = await writer.preview(tx());
      await writer.commit();
      assert.equal(await readFile(setup.transactions, "utf8"), `; header\n\n${preview.transactionText}`);
    });
  }
});

test("候选交易显式拒绝 cost、price 和 lot 语法", async () => {
  const setup = await workspace("unsupported-posting-syntax");
  const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace, pythonExecutable: join(root, "missing-runtime") });
  for (const amount of ["10 USD {1 EUR}", "10 USD @ 7 CNY", "10 USD @@ 70 CNY"]) {
    await assert.rejects(
      writer.preview({ ...tx(), postings: [{ account: "Expenses:Food", amount }, { account: "Assets:Wallet" }] }),
      (error: unknown) => error instanceof FinanceError && error.code === "invalid_transaction_batch" && /cost、price 或 lot/u.test(error.message),
    );
  }
});

test("新年度文件仅在确认后以 0600 原子创建，外部先建时批次拒绝且不留临时文件", async () => {
  const setup = await workspace("new-year");
  const external = await workspace("new-year-stale");
  const runtime = await fakeRuntime("new-year", setup.ledger);
  const externalRuntime = await fakeRuntime("new-year-stale", external.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime }, async () => {
    const target = join(setup.ledger, "transactions", "2027.beancount");
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    const preview = await writer.preview({ ...tx(), date: "2027-01-01" });
    assert.equal(preview.createsFile, true);
    assert.equal(await exists(target), false);
    const result = await writer.commit();
    assert.equal(result.targetFile, "transactions/2027.beancount");
    assert.equal(await readFile(target, "utf8"), result.transactionText);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  });
  await withEnv({ MONEYPAL_PYTHON: externalRuntime }, async () => {
    const externalWriter = await createConfirmedTransactionWriter({ ledgerWorkspace: external.workspace });
    await externalWriter.preview({ ...tx(), date: "2027-01-02" });
    const externalTarget = join(external.ledger, "transactions", "2027.beancount");
    await writeFile(externalTarget, "; external\n");
    await assert.rejects(externalWriter.commit(), (error: unknown) => error instanceof FinanceError && error.code === "preview_stale");
    assert.equal(await readFile(externalTarget, "utf8"), "; external\n");
    assert.deepEqual((await readdir(join(external.ledger, "transactions"))).filter((file) => file.startsWith(".moneypal-write-")), []);
  });
});

test("确认期间 include 文件集合或字节变化时批次整体拒绝", async () => {
  const setup = await workspace("include-stale-workspace");
  const runtime = await fakeRuntime("include-stale", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    await writer.preview(tx());
    await writeFile(join(setup.ledger, "extra.beancount"), "; external\n");
    await writeFile(join(setup.ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\ninclude "extra.beancount"\n');
    await assert.rejects(writer.commit(), (error: unknown) => error instanceof FinanceError && error.code === "preview_stale");
    assert.equal(await readFile(setup.transactions, "utf8"), "");
  });
});

test("整批一次提交，不按数量隐式切分", async () => {
  const setup = await workspace("no-chunking-workspace");
  const runtime = await fakeRuntime("no-chunking", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    const preview = await writer.preview(Array.from({ length: 120 }, (_, index) => tx(`餐费 ${index + 1}`)));
    assert.equal(preview.transactions.length, 1, "假运行时按整批只返回一份规范文本，写入路径不得自行切分");
    const result = await writer.commit();
    assert.equal(result.transactions.length, 1);
    assert.equal(await readFile(setup.transactions, "utf8"), result.transactionText);
  });
});

test("校验失败（重新校验拒绝）时零写入且批次作废", async () => {
  const setup = await workspace("validate-fail-workspace");
  const runtime = await fakeRuntime("validate-fail", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime, MONEYPAL_FAKE_VALIDATE_FAIL: "1" }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    await writer.preview(tx());
    await assert.rejects(writer.commit(), (error: unknown) => error instanceof FinanceError && error.code === "invalid_transaction_batch");
    assert.equal(await readFile(setup.transactions, "utf8"), "");
  });
});

test("发布阶段故障返回 write_outcome_uncertain，保留恢复信息且不自动重试", async () => {
  const setup = await workspace("publish-fault-workspace");
  const runtime = await fakeRuntime("publish-fault", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime, MONEYPAL_FAULT_RENAME: "1" }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    await writer.preview(tx());
    await assert.rejects(writer.commit(), (error: unknown) => error instanceof FinanceError && error.code === "write_outcome_uncertain");
    assert.equal(await readFile(setup.transactions, "utf8"), "");
    // 恢复信息保留：replacement 保留在目标目录，命名不匹配 include 通配，不会被账本加载。
    const leftovers = (await readdir(join(setup.ledger, "transactions"))).filter((file) => file.startsWith(".moneypal-write-"));
    assert.equal(leftovers.length, 1);
    assert.doesNotMatch(leftovers[0]!, /\.beancount$/u);
  });
});

test("发布后目录同步失败返回不确定写入，正式账本已含交易且禁止自动重试", async () => {
  const setup = await workspace("fsync-fault-workspace");
  const runtime = await fakeRuntime("fsync-fault", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime, MONEYPAL_FAULT_FSYNC_PARENT: "1" }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    await writer.preview(tx());
    await assert.rejects(writer.commit(), (error: unknown) => error instanceof FinanceError && error.code === "write_outcome_uncertain" && /先查询正式账本/u.test(error.message));
    assert.match(await readFile(setup.transactions, "utf8"), /2026-08-25 \* "午餐"/u);
    await assert.rejects(writer.commit(), (error: unknown) => error instanceof FinanceError && error.code === "invalid_transaction_batch");
  });
});

test("发布成功后锁清理失败仍返回成功并记录警告，遗留锁阻止下一次写入", async () => {
  const setup = await workspace("cleanup-fault-workspace");
  const runtime = await fakeRuntime("cleanup-fault", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime, MONEYPAL_FAULT_LOCK_CLEANUP: "1" }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    await writer.preview(tx());
    const result = await writer.commit();
    assert.ok(result.warnings && result.warnings.length === 1);
    assert.match(result.warnings[0]!, /账本锁清理失败/u);
    assert.equal(await exists(join(setup.ledger, ".moneypal-write.lock")), true);

    const follower = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    await follower.preview({ ...tx(), description: "晚餐" });
    await assert.rejects(follower.commit(), (error: unknown) => error instanceof FinanceError && error.code === "ledger_locked");
  });
});

test("并发提交由账本锁互斥，恰好一个成功且不产生部分写入", async () => {
  const setup = await workspace("concurrent-workspace");
  const runtime = await fakeRuntime("concurrent", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime, MONEYPAL_FAKE_SLEEP: "1" }, async () => {
    const first = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    const second = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    await Promise.all([first.preview(tx("午餐")), second.preview(tx("晚餐"))]);
    const [firstResult, secondResult] = await Promise.allSettled([first.commit(), second.commit()]);
    const rejected = [firstResult, secondResult].find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    const fulfilled = [firstResult, secondResult].find((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof first.commit>>> => outcome.status === "fulfilled");
    assert.ok(fulfilled, "并发提交必须恰好一个成功");
    assert.ok(rejected && rejected.reason instanceof FinanceError && rejected.reason.code === "ledger_locked");
    const content = await readFile(setup.transactions, "utf8");
    assert.match(content, /\* "午餐"/u);
    assert.doesNotMatch(content, /\* "晚餐"/u);
  });
});

test("提交前取消保证零写入，临时文件被删除", async () => {
  const setup = await workspace("cancel-workspace");
  const runtime = await fakeRuntime("cancel", setup.ledger);
  await withEnv({ MONEYPAL_PYTHON: runtime, MONEYPAL_FAKE_SLEEP: "1" }, async () => {
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: setup.workspace });
    await writer.preview(tx());
    const controller = new AbortController();
    const attempt = writer.commit(controller.signal);
    setTimeout(() => controller.abort(new FinanceError("cancelled", "写入提交前已取消，正式账本未修改。")), 100);
    await assert.rejects(attempt, (error: unknown) => error instanceof FinanceError && error.code === "cancelled");
    assert.equal(await readFile(setup.transactions, "utf8"), "");
    assert.deepEqual((await readdir(join(setup.ledger, "transactions"))).filter((file) => file.startsWith(".moneypal-write-")), []);
    assert.equal(await exists(join(setup.ledger, ".moneypal-write.lock")), false);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
