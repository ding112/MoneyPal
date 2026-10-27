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
  const routes = new Map<string, (request: Request) => Promise<Response>>(); const warnings: string[] = []; const disposers: Array<() => void | Promise<void>> = [];
  const context = { sessions: { get: (id: string) => sessions.get(id) }, connection: { fetch: { register: (route: { path: string; methods: string[]; requestBody: "buffered"; fetch(request: Request): Promise<Response> }) => { assert.deepEqual(route.methods, ["POST"]); assert.equal(route.requestBody, "buffered"); if (routes.has(route.path)) throw new Error("duplicate route"); routes.set(route.path, route.fetch); return () => { routes.delete(route.path); }; } } }, logger: { warn: (message: string) => { warnings.push(message); } }, effect: (callback: () => () => void | Promise<void>) => { const dispose = callback(); disposers.push(dispose); return dispose; } };
  const start = () => apply(context); start();
  const request = (endpoint: string, body: string, headers: Record<string, string> = { "content-type": "application/json" }, signal?: AbortSignal) => routes.get(`/api/dsh-moneypal/${endpoint}`)!(new Request(`http://localhost/api/dsh-moneypal/${endpoint}`, { method: "POST", headers, body, signal }));
  return { request, routes, start, call: async (endpoint: string, payload: unknown, signal?: AbortSignal) => { const response = await request(endpoint, JSON.stringify({ type: "client-request", rpcId: "test-id", method: `dsh-moneypal/${endpoint}`, payload }), undefined, signal); assert.equal(response.status, 200); const envelope = await response.json() as { type: string; rpcId: string; result: unknown }; assert.equal(envelope.type, "server-response"); assert.equal(envelope.rpcId, "test-id"); return envelope.result; }, warnings, disposers };
}

test("余额接口仅以 live session 的工作区判断账本候选", async () => {
  const ledger = await workspace("ledger"); const ordinary = join(root, "ordinary"); await mkdir(ordinary);
  const service = rpc(new Map([["ledger", { header: { cwd: ledger } }], ["ordinary", { header: { cwd: ordinary } }]]));
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

test("Host 路由随插件卸载并可重新启用", async () => {
  const ledger = await workspace("lifecycle");
  const service = rpc(new Map([["ledger", { header: { cwd: ledger } }]]));
  assert.deepEqual(await service.call("capability", { sessionId: "ledger" }), { ok: true, value: { ok: true, value: { candidate: true } } });
  assert.equal(service.routes.size, 2);
  for (const dispose of service.disposers.splice(0)) await dispose();
  assert.equal(service.routes.size, 0);
  service.start();
  assert.equal(service.routes.size, 2);
  assert.equal((await service.call("capability", { sessionId: "ledger" }) as { ok: boolean }).ok, true);
  for (const dispose of service.disposers.splice(0)) await dispose();
});

test("路由校验 RPC 信封并拒绝无效输入", async () => {
  const service = rpc(new Map());
  assert.equal((await service.request("capability", "{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await service.request("capability", "{")).status, 400);
  for (const value of [null, [], {}, { type: "client-request", rpcId: "", method: "dsh-moneypal/capability" }, { type: "client-request", rpcId: "1", method: "dsh-moneypal/balances" }]) {
    const response = await service.request("capability", JSON.stringify(value));
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "invalid request");
  }
});

test("余额请求取消信号传递到运行时", async () => {
  const ledger = await workspace("cancelled"); const service = rpc(new Map([["ledger", { header: { cwd: ledger } }]]));
  const controller = new AbortController(); controller.abort();
  const result = await service.call("balances", { sessionId: "ledger", asOf: "2026-08-27" }, controller.signal) as { value: { ok: false; error: { code: string } } };
  assert.equal(result.value.error.code, "cancelled");
});
