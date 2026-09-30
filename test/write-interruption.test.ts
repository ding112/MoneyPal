import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { FinanceError } from "../src/finance/errors.js";
import { createConfirmedTransactionWriter } from "../src/finance/write.js";

let root: string;

before(async () => { root = await mkdtemp(join(tmpdir(), "moneypal-interrupt-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error("等待条件超时");
}

test("进程在提交中途被终止后，账本零修改、遗留锁不被自动删除且阻止下一次写入", async () => {
  const workspace = join(root, "interrupted");
  const ledger = join(workspace, "default");
  const transactions = join(ledger, "transactions", "2026.beancount");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  await writeFile(transactions, "");

  const runtime = join(root, "slow-runtime.sh");
  const validateMarker = join(root, "validate-marker");
  const loadedFiles = [join(ledger, "main.beancount"), join(ledger, "accounts.beancount"), join(ledger, "transactions", "2026.beancount")];
  const preview = {
    validation: "passed",
    transactions: ['2026-08-25 * "午餐"\n  Expenses:Food   12 CNY\n  Assets:Wallet  -12 CNY\n'],
    transactionText: '2026-08-25 * "午餐"\n  Expenses:Food   12 CNY\n  Assets:Wallet  -12 CNY\n',
    amountSummary: [{ commodity: "CNY", income: "0", expenses: "12", netIncome: "-12" }],
    duplicateWarnings: [],
    loadedFiles,
  };
  await writeFile(runtime, `#!/bin/sh
request=$(cat)
case "$request" in
  *'"operation":"preview"'*) printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime: { python: "3.11.11", beancount: "3.2.3", beanquery: "0.2.0" }, ok: true, result: preview })}' ;;
  *'"operation":"validate_candidates"'*) touch "$MONEYPAL_FAKE_MARKER"; sleep 30; printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime: { python: "3.11.11", beancount: "3.2.3", beanquery: "0.2.0" }, ok: true, result: { valid: true, loadedFiles } })}' ;;
  *) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"valid":true}}' ;;
esac
`, { mode: 0o700 });
  await chmod(runtime, 0o700);

  const startMarker = join(root, "start-marker");
  const writerModule = fileURLToPath(new URL("../src/finance/write.js", import.meta.url));
  const script = join(root, "child.mjs");
  await writeFile(script, `import { writeFile } from "node:fs/promises";
const { createConfirmedTransactionWriter } = await import(process.env.MONEYPAL_WRITER_MODULE);
const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: process.env.MONEYPAL_WS });
await writer.preview({ date: "2026-08-25", description: "午餐", postings: [{ account: "Expenses:Food", amount: "12 CNY" }, { account: "Assets:Wallet" }] });
await writeFile(process.env.MONEYPAL_START_MARKER, "started");
await writer.commit();
`);

  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      MONEYPAL_PYTHON: runtime,
      MONEYPAL_WRITER_MODULE: writerModule,
      MONEYPAL_WS: workspace,
      MONEYPAL_START_MARKER: startMarker,
      MONEYPAL_FAKE_MARKER: validateMarker,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

  try {
    await waitFor(async () => { try { await stat(startMarker); return true; } catch { return false; } });
    await waitFor(async () => { try { await stat(join(ledger, ".moneypal-write.lock")); return true; } catch { return false; } });
    await waitFor(async () => { try { await stat(validateMarker); return true; } catch { return false; } });
    child.kill("SIGKILL");
    const code = await exited;
    assert.notEqual(code, 0);
    assert.equal(await readFile(transactions, "utf8"), "", "进程中断时不得留下部分或完整写入");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
  assert.doesNotMatch(stderr, /Traceback/u);

  // 遗留锁不自动删除：下一次写入必须由账本维护介入，而不是静默绕过。
  assert.equal(await exists(join(ledger, ".moneypal-write.lock")), true);
  const recovery = await createConfirmedTransactionWriter({ ledgerWorkspace: workspace, pythonExecutable: runtime });
  await recovery.preview({ date: "2026-08-26", description: "晚餐", postings: [{ account: "Expenses:Food", amount: "12 CNY" }, { account: "Assets:Wallet" }] });
  await assert.rejects(recovery.commit(), (error: unknown) => error instanceof FinanceError && error.code === "ledger_locked");
  assert.equal(await readFile(transactions, "utf8"), "");
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
