import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { after, before, test } from "node:test";
import { directoryHints } from "../src/ledger-registry.js";
import { apply } from "../src/host.js";
import { readBalanceSnapshot } from "../src/balance.js";
import { FinanceError } from "../src/finance/errors.js";

let root: string; let runtime: string; let originalPython: string | undefined;
before(async () => { root = await mkdtemp(join(tmpdir(), "dsh-moneypal-balance-")); runtime = join(root, "runtime.sh"); await writeFile(runtime, `#!/bin/sh
request=$(cat)
case "$request" in *'broken-layout'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":false,"error":{"code":"invalid_ledger_layout"}}' ;; *'"operation":"balance"'*'isolate-family'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"range":{"begin":null,"end":"2026-08-28"},"accounts":[{"account":"Assets:Family-现金","amounts":[{"commodity":"CNY","quantity":"111.00"}]}],"totals":[]}}' ;; *'"operation":"balance"'*'isolate-side'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"range":{"begin":null,"end":"2026-08-28"},"accounts":[{"account":"Assets:Side-现金","amounts":[{"commodity":"CNY","quantity":"222.00"}]}],"totals":[]}}' ;; *'"operation":"balance"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"range":{"begin":null,"end":"2026-08-28"},"accounts":[{"account":"Assets:C-现金","amounts":[{"commodity":"CNY","quantity":"1234.500"},{"commodity":"USD","quantity":"0.3"}]},{"account":"Liabilities:C-信用卡","amounts":[{"commodity":"CNY","quantity":"-12.34"}]}],"totals":[]}}' ;; *) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"valid":true}}' ;; esac
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

/** 按 DSH workspaceRegistry 的登记记录形状构造实体（id/path/title）。 */
function entity(id: string, path: string, title = id): { id: string; path: string; title: string } {
  return { id, path, title };
}

/** 候选路由的可选 workspaceRegistry 服务夹具；list/get 均可替换以模拟宿主故障。 */
function registry(entities: Array<{ id: string; path: string; title: string }>, overrides: { list?: unknown; get?: (id: string) => unknown } = {}) {
  return {
    list: overrides.list ?? (() => entities),
    get: overrides.get ?? ((id: string) => entities.find((candidate) => candidate.id === id)),
  };
}

function rpc(sessions: Map<string, { header: { cwd: string } }>, services: Record<string, unknown> = {}) {
  const routes = new Map<string, (request: Request) => Promise<Response>>(); const warnings: string[] = []; const disposers: Array<() => void | Promise<void>> = [];
  const context = { sessions: { get: (id: string) => sessions.get(id) }, connection: { fetch: { register: (route: { path: string; methods: string[]; requestBody: "buffered"; fetch(request: Request): Promise<Response> }) => { assert.deepEqual(route.methods, ["POST"]); assert.equal(route.requestBody, "buffered"); if (routes.has(route.path)) throw new Error("duplicate route"); routes.set(route.path, route.fetch); return () => { routes.delete(route.path); }; } } }, get: (name: string) => services[name], logger: { warn: (message: string) => { warnings.push(message); } }, effect: (callback: () => () => void | Promise<void>) => { const dispose = callback(); disposers.push(dispose); return dispose; } };
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
  assert.equal(service.routes.size, 4);
  for (const dispose of service.disposers.splice(0)) await dispose();
  assert.equal(service.routes.size, 0);
  service.start();
  assert.equal(service.routes.size, 4);
  assert.equal((await service.call("capability", { sessionId: "ledger" }) as { ok: boolean }).ok, true);
  for (const dispose of service.disposers.splice(0)) await dispose();
});

test("路由校验 RPC 信封并拒绝无效输入", async () => {
  const service = rpc(new Map());
  assert.equal((await service.request("capability", "{}", { "content-type": "text/plain" })).status, 415);
  assert.equal((await service.request("capability", "{")).status, 400);
  for (const value of [null, [], {}, { type: "client-request", rpcId: "", method: "dsh-moneypal/ledger-candidates" }, { type: "client-request", rpcId: "1", method: "dsh-moneypal/none" }]) {
    const response = await service.request("ledger-candidates", JSON.stringify(value));
    assert.equal(response.status, 400);
  }
});

test("余额请求取消信号传递到运行时", async () => {
  const ledger = await workspace("cancelled"); const service = rpc(new Map([["ledger", { header: { cwd: ledger } }]]));
  const controller = new AbortController(); controller.abort();
  const result = await service.call("balances", { sessionId: "ledger", asOf: "2026-08-27" }, controller.signal) as { value: { ok: false; error: { code: string } } };
  assert.equal(result.value.error.code, "cancelled");
});

test("候选查询按登记顺序返回四类预检状态", async () => {
  const ok = await workspace("candidates-ok");
  const uninit = join(root, "candidates-uninit"); await mkdir(uninit);
  const missingEntry = await workspace("candidates-missing-entry"); await rm(join(missingEntry, "default", "main.beancount"));
  const typedEntry = await workspace("candidates-typed-entry"); await rm(join(typedEntry, "default", "main.beancount")); await mkdir(join(typedEntry, "default", "main.beancount"));
  const typedDirectory = join(root, "candidates-typed-directory");
  await mkdir(typedDirectory);
  await writeFile(join(typedDirectory, "default"), "");
  const entities = [entity("typed-directory", typedDirectory), entity("gone", join(root, "candidates-gone"), "离线账本"), entity("uninit", uninit), entity("missing-entry", missingEntry), entity("typed-entry", typedEntry), entity("ok", ok)];
  const service = rpc(new Map(), { workspaceRegistry: registry(entities) });
  const result = await service.call("ledger-candidates", {}) as { ok: true; value: { ok: true; value: { candidates: Array<{ workspaceId: string; title: string; status: string; directoryHint?: string }> } } };
  assert.deepEqual(result.value.value.candidates, [
    { workspaceId: "typed-directory", title: "typed-directory", status: "invalid_layout" },
    { workspaceId: "gone", title: "离线账本", status: "unavailable" },
    { workspaceId: "uninit", title: "uninit", status: "uninitialized" },
    { workspaceId: "missing-entry", title: "missing-entry", status: "invalid_layout" },
    { workspaceId: "typed-entry", title: "typed-entry", status: "invalid_layout" },
    { workspaceId: "ok", title: "ok", status: "candidate" },
  ]);
  assert.equal(JSON.stringify(result).includes(root), false, "候选结果不得携带工作区绝对路径");
});

test("无读权限的主账本属于暂不可用", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const ledger = await workspace("unreadable");
  const entry = join(ledger, "default", "main.beancount");
  await chmod(entry, 0);
  try {
    const service = rpc(new Map(), { workspaceRegistry: registry([entity("private", ledger)]) });
    const result = await service.call("ledger-candidates", {}) as { value: { value: { candidates: [{ status: string }] } } };
    assert.equal(result.value.value.candidates[0].status, "unavailable");
  } finally { await chmod(entry, 0o600); }
});

test("Windows 根目录不足以区分同名候选时使用工作区 ID", () => {
  for (const roots of [["C:/", "D:/"], ["//server/private/", "//otherserver/secret/"]]) {
    const entries = roots.map((root, index) => ({ workspaceId: String(index), path: root + "team/ledger" }));
    assert.deepEqual(directoryHints(entries, win32), ["#0", "#1"]);
  }
});

test("同名候选获得目录提示，不同名或非候选不提示", async () => {
  const personal = await workspace("personal/ledger");
  const shared = await workspace("shared/ledger");
  const family = await workspace("family-ledger");
  const broken = await workspace("broken/ledger"); await rm(join(broken, "default", "main.beancount"));
  const service = rpc(new Map(), { workspaceRegistry: registry([
    entity("p", personal, "账本"), entity("s", shared, "账本"), entity("f", family, "家庭账本"), entity("b", broken, "账本"),
  ]) });
  const result = await service.call("ledger-candidates", {}) as { ok: true; value: { ok: true; value: { candidates: Array<{ workspaceId: string; directoryHint?: string }> } } };
  const candidates = result.value.value.candidates;
  assert.deepEqual(candidates.map(({ workspaceId, directoryHint }) => ({ workspaceId, directoryHint })), [
    { workspaceId: "p", directoryHint: "personal/ledger" },
    { workspaceId: "s", directoryHint: "shared/ledger" },
    { workspaceId: "f", directoryHint: undefined },
    { workspaceId: "b", directoryHint: undefined },
  ]);
});

test("注册表服务缺失或故障时候选查询返回稳定可重试错误", async () => {
  const failing = rpc(new Map());
  const missing = await failing.call("ledger-candidates", {}) as { ok: true; value: { ok: false; error: { code: string; message: string; details: Record<string, never> } } };
  assert.equal(missing.value.error.code, "workspace_registry_unavailable");
  const broken = rpc(new Map(), { workspaceRegistry: registry([], { list: () => { throw new Error("registry down"); } }) });
  const result = await broken.call("ledger-candidates", {}) as { ok: true; value: { ok: false; error: { code: string } } };
  assert.equal(result.value.error.code, "workspace_registry_unavailable");
  assert.deepEqual(failing.warnings, ["dsh-moneypal ledger RPC workspace_registry_unavailable"]);
  assert.deepEqual(broken.warnings, ["dsh-moneypal ledger RPC workspace_registry_unavailable"]);
  assert.equal(JSON.stringify(result).includes("registry down"), false);
});

test("registry 服务缺失时旧会话接口（capability/balances）不受影响", async () => {
  const ledger = await workspace("registry-less");
  const service = rpc(new Map([["ledger", { header: { cwd: ledger } }]]));
  assert.deepEqual(await service.call("capability", { sessionId: "ledger" }), { ok: true, value: { ok: true, value: { candidate: true } } });
  const result = await service.call("balances", { sessionId: "ledger", asOf: "2026-08-27" }) as { ok: true; value: { ok: true; value: { assets: { accounts: Array<{ account: string; amounts: Array<{ commodity: string; quantity: string }> }> } } } };
  assert.equal(result.value.ok, true, "旧接口按 sessionId 语义工作，不读取 workspaceRegistry");
  assert.deepEqual(result.value.value.assets.accounts[0]?.amounts[0], { commodity: "CNY", quantity: "1234.500" });
});

test("余额查询按 ID 重新解析登记并交给现有引擎", async () => {
  const ledger = await workspace("ledger-by-id");
  const service = rpc(new Map(), { workspaceRegistry: registry([entity("ledger", ledger)]) });
  const result = await service.call("ledger-balances", { workspaceId: "ledger", asOf: "2026-08-27" }) as { ok: true; value: { ok: true; value: { assets: { accounts: Array<{ account: string; amounts: Array<{ commodity: string; quantity: string }> }> } } } };
  assert.equal(result.value.ok, true);
  assert.deepEqual(result.value.value.assets.accounts[0]?.amounts[0], { commodity: "CNY", quantity: "1234.500" });
  assert.equal(JSON.stringify(result).includes(ledger), false, "余额结果不得携带工作区绝对路径");
});

test("按工作区查询时取消信号传到运行时", async () => {
  const ledger = await workspace("ledger-cancelled");
  const service = rpc(new Map(), { workspaceRegistry: registry([entity("ledger", ledger)]) });
  const controller = new AbortController(); controller.abort();
  const cancelled = await service.call("ledger-balances", { workspaceId: "ledger", asOf: "2026-08-27" }, controller.signal) as { value: { ok: false; error: { code: string } } };
  assert.equal(cancelled.value.error.code, "cancelled");
});

test("按工作区查询要求 ID 和有效日期", async () => {
  const service = rpc(new Map(), { workspaceRegistry: registry([]) });
  for (const payload of [{ asOf: "2026-08-27" }, { workspaceId: "ledger" }, { workspaceId: "ledger", asOf: "2026-13-01" }]) {
    const invalid = await service.call("ledger-balances", payload) as { value: { ok: false; error: { code: string } } };
    assert.equal(invalid.value.error.code, "malformed_request", JSON.stringify(payload));
  }
});

test("同名候选各自按工作区 ID 查询，两个账本的余额彼此隔离", async () => {
  const family = await workspace("isolate-family");
  const side = await workspace("isolate-side");
  const service = rpc(new Map(), { workspaceRegistry: registry([entity("family", family, "账本"), entity("side", side, "账本")]) });
  const candidates = await service.call("ledger-candidates", {}) as { ok: true; value: { ok: true; value: { candidates: Array<{ workspaceId: string; title: string; status: string; directoryHint?: string }> } } };
  assert.deepEqual(candidates.value.value.candidates, [
    { workspaceId: "family", title: "账本", status: "candidate", directoryHint: "isolate-family" },
    { workspaceId: "side", title: "账本", status: "candidate", directoryHint: "isolate-side" },
  ]);
  const familyBalances = await service.call("ledger-balances", { workspaceId: "family", asOf: "2026-08-27" }) as { ok: true; value: { ok: true; value: { assets: { accounts: Array<{ account: string; amounts: Array<{ quantity: string }> }> } } } };
  assert.deepEqual(familyBalances.value.value.assets.accounts.map((account) => account.account), ["Assets:Family-现金"], "family ID 只返回家庭账本的余额");
  assert.deepEqual(familyBalances.value.value.assets.accounts[0]?.amounts, [{ commodity: "CNY", quantity: "111.00" }]);
  const sideBalances = await service.call("ledger-balances", { workspaceId: "side", asOf: "2026-08-27" }) as { ok: true; value: { ok: true; value: { assets: { accounts: Array<{ account: string }> } } } };
  assert.deepEqual(sideBalances.value.value.assets.accounts.map((account) => account.account), ["Assets:Side-现金"], "side ID 只返回副业账本的余额");
});

test("登记缺失或目录离线时余额查询返回专用错误码", async () => {
  const ledger = await workspace("ledger-errors");
  const broken = await workspace("ledger-broken-layout"); await writeFile(join(broken, "default", "main.beancount"), 'include "missing.beancount"\n');
  const service = rpc(new Map(), { workspaceRegistry: registry([
    entity("ledger", ledger), entity("gone", join(root, "ledger-gone")), entity("broken", broken),
  ]) });
  const unregistered = await service.call("ledger-balances", { workspaceId: "missing", asOf: "2026-08-27" }) as { value: { ok: false; error: { code: string; message: string; details: Record<string, never> } } };
  assert.equal(unregistered.value.error.code, "workspace_not_registered");
  const offline = await service.call("ledger-balances", { workspaceId: "gone", asOf: "2026-08-27" }) as { value: { ok: false; error: { code: string } } };
  assert.equal(offline.value.error.code, "workspace_unavailable");
  const invalidLayout = await service.call("ledger-balances", { workspaceId: "broken", asOf: "2026-08-27" }) as { value: { ok: false; error: { code: string; message: string } } };
  assert.equal(invalidLayout.value.error.code, "invalid_ledger_layout", "布局错误仍沿用引擎的净化码");
  assert.equal(JSON.stringify(invalidLayout).includes(broken), false);
  assert.deepEqual(service.warnings, [
    "dsh-moneypal ledger RPC workspace_not_registered",
    "dsh-moneypal ledger RPC workspace_unavailable",
    "dsh-moneypal ledger RPC invalid_ledger_layout",
  ]);
});
