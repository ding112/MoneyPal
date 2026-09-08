import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { apply } from "../src/host.js";
import { readBalanceSnapshot } from "../src/balance.js";
import { FinanceError } from "../src/finance/errors.js";

let root: string; let runtime: string; let originalPython: string | undefined;
before(async () => { root = await mkdtemp(join(tmpdir(), "dsh-moneypal-balance-")); runtime = join(root, "runtime.sh"); await writeFile(runtime, `#!/bin/sh
request=$(cat)
case "$request" in *'broken-layout'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":false,"error":{"code":"invalid_ledger_layout"}}' ;; *'"operation":"balance"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"range":{"begin":null,"end":"2026-08-28"},"accounts":[{"account":"Assets:C-现金","amounts":[{"commodity":"CNY","quantity":"1234.500"},{"commodity":"USD","quantity":"0.3"}]},{"account":"Liabilities:C-信用卡","amounts":[{"commodity":"CNY","quantity":"-12.34"}]}],"totals":[]}}' ;; *) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"valid":true}}' ;; esac
`, { mode: 0o700 }); await chmod(runtime, 0o700); originalPython = process.env.MONEYPAL_PYTHON; process.env.MONEYPAL_PYTHON = runtime; });
after(async () => { if (originalPython === undefined) delete process.env.MONEYPAL_PYTHON; else process.env.MONEYPAL_PYTHON = originalPython; await rm(root, { recursive: true, force: true }); });

async function workspace(name: string): Promise<string> {
  const value = join(root, name); const ledger = join(value, "default");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:C-现金\n2026-01-01 open Liabilities:C-信用卡\n");
  await writeFile(join(ledger, "transactions", "2026.beancount"), "");
  return value;
}

function rpc(sessions: Map<string, { header: { cwd: string } }>) {
  let handler: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined; let options: unknown; const warnings: string[] = []; const disposers: Array<() => void> = []; let unregistered = 0;
  apply({ sessions: { get: (id) => sessions.get(id) }, connection: { rpc: { handle: (_channel, value, policy) => { handler = value; options = policy; return () => { unregistered += 1; }; } } }, logger: { warn: (message: string) => { warnings.push(message); } }, effect: (callback: () => () => void) => { const dispose = callback(); disposers.push(dispose); return dispose; } });
  return { call: (endpoint: string, payload: unknown) => handler!(endpoint, payload, new AbortController().signal), options, warnings, disposers, get unregistered(): number { return unregistered; } };
}

test("全局 RPC 仅以 live session 的工作区判断账本候选，并限制 loopback", async () => {
  const ledger = await workspace("ledger"); const ordinary = join(root, "ordinary"); await mkdir(ordinary);
  const service = rpc(new Map([["ledger", { header: { cwd: ledger } }], ["ordinary", { header: { cwd: ordinary } }]]));
  assert.deepEqual(service.options, { authority: "loopback" });
  assert.deepEqual(await service.call("capability", { sessionId: "ledger", cwd: ordinary }), { ok: true, value: { ok: true, value: { candidate: true } } });
  assert.deepEqual(await service.call("capability", { sessionId: "ordinary" }), { ok: true, value: { ok: true, value: { candidate: false } } });
  assert.deepEqual(await service.call("capability", { sessionId: "missing" }), { ok: true, value: { ok: false, error: { code: "session_unavailable", message: "当前会话尚未挂载账本工作区，请稍后重试。", details: {} } } });
});

test("余额 RPC 保留精度并按资产负债分组", async () => {
  const ledger = await workspace("balances"); const service = rpc(new Map([["ledger", { header: { cwd: ledger } }]]));
  const result = await service.call("balances", { sessionId: "ledger", asOf: "2026-08-27" }) as { ok: true; value: { ok: true; value: { assets: { accounts: Array<{ account: string; amounts: Array<{ quantity: string }> }> }; liabilities: { accounts: Array<{ account: string }> } } } };
  assert.equal(result.value.ok, true); assert.deepEqual(result.value.value.assets.accounts.map((account) => account.account), ["Assets:C-现金"]);
  assert.deepEqual(result.value.value.assets.accounts[0]?.amounts[0], { commodity: "CNY", quantity: "1234.500" });
  assert.deepEqual(result.value.value.liabilities.accounts.map((account) => account.account), ["Liabilities:C-信用卡"]);
});

test("存在主账本但布局无效时仍是账本候选，余额查询映射为安全的布局错误", async () => {
  const broken = join(root, "broken-layout"); const ledgerDirectory = join(broken, "default");
  await mkdir(join(ledgerDirectory, "transactions"), { recursive: true });
  await writeFile(join(ledgerDirectory, "main.beancount"), 'include "missing.beancount"\n');
  await writeFile(join(ledgerDirectory, "accounts.beancount"), "2026-01-01 open Assets:C-现金\n");
  await writeFile(join(ledgerDirectory, "transactions", "2026.beancount"), "");
  const service = rpc(new Map([["broken", { header: { cwd: broken } }]]));
  assert.deepEqual(await service.call("capability", { sessionId: "broken" }), { ok: true, value: { ok: true, value: { candidate: true } } });
  const result = await service.call("balances", { sessionId: "broken", asOf: "2026-08-27" }) as { ok: true; value: { ok: false; error: { code: string; message: string } } };
  assert.equal(result.value.ok, false);
  assert.equal(result.value.error.code, "invalid_ledger_layout");
  assert.equal(result.value.error.message, "账本布局不符合 MoneyPal 的 Beancount 约束；请修复后重试。");
  assert.equal(JSON.stringify(result).includes(broken), false);
  assert.deepEqual(service.warnings, ["dsh-moneypal balance RPC invalid_ledger_layout"]);
});

test("RPC 内部错误净化为稳定响应，警告只记录稳定事件码", async () => {
  const ledger = await workspace("host-error");
  const hostile = { get header(): { cwd: string } { throw new Error(`内部探测 ${ledger}`); } };
  const service = rpc(new Map([["boom", hostile]]));
  for (let round = 0; round < 2; round += 1) {
    const result = await service.call("capability", { sessionId: "boom" }) as { ok: true; value: { ok: false; error: { code: string; message: string; details: Record<string, never> } } };
    assert.equal(result.value.ok, false);
    assert.deepEqual(result.value.error, { code: "balance_unavailable", message: "暂时无法读取账户余额，请稍后重试。", details: {} });
    assert.equal(JSON.stringify(result).includes(ledger), false);
    assert.equal(JSON.stringify(result).includes("内部探测"), false);
  }
  assert.deepEqual(service.warnings, ["dsh-moneypal balance RPC balance_unavailable", "dsh-moneypal balance RPC balance_unavailable"]);
});

test("运行时不可用时余额查询映射为稳定的设置提示", async () => {
  const ledger = await workspace("without-legacy-runtime");
  const configured = process.env.MONEYPAL_PYTHON;
  process.env.MONEYPAL_PYTHON = join(root, "missing-python");
  try {
    await assert.rejects(readBalanceSnapshot(ledger, "2026-08-27"), (error: unknown) => {
      assert.ok(error instanceof FinanceError);
      assert.equal(error.code, "runtime_unavailable");
      assert.equal(error.message, "MoneyPal 运行时不可用；请执行 setup-runtime，或检查 MONEYPAL_PYTHON。");
      return true;
    });
  } finally { process.env.MONEYPAL_PYTHON = configured; }
});

test("Host RPC disposer 纳入 Cordis effect，卸载后通道注销", async () => {
  const ledger = await workspace("lifecycle");
  const service = rpc(new Map([["ledger", { header: { cwd: ledger } }]]));
  assert.deepEqual(await service.call("capability", { sessionId: "ledger" }), { ok: true, value: { ok: true, value: { candidate: true } } });
  assert.equal(service.unregistered, 0);
  assert.equal(service.disposers.length, 1, "RPC 注册未纳入 ctx.effect");
  for (const dispose of service.disposers) dispose();
  assert.equal(service.unregistered, 1);
});
