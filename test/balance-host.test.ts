import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runInNewContext } from "node:vm";
import { apply } from "../src/host.js";
import { dayAfter, readBalanceSnapshot, snapshotFromBalance, type BalanceSnapshot } from "../src/balance.js";
import { FinanceError } from "../src/finance/errors.js";
import { BalanceClientError, BalanceController, footerStatus, formatAmount, formatAmountParts, selectPreviewAccounts } from "../src/client.js";

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

test("DSH bundle patch 以精确包根挂载全局适配器，不使用子路径", async () => {
  const patch = await readFile(new URL("../../cordis.patch.yml", import.meta.url), "utf8");
  assert.match(patch, /- insert:\n    - id: dsh-moneypal\n      name: dsh-moneypal(?:\n|$)/u);
  assert.doesNotMatch(patch, /name:\s*dsh-moneypal\//u);
});

test("DSH 客户端可解析包元数据与客户端入口", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../packages/dsh-moneypal/package.json", import.meta.url), "utf8")) as { exports: Record<string, unknown>; dsh: { client: unknown } };
  assert.equal(packageJson.exports["./package.json"], "./package.json");
  assert.ok(packageJson.exports["."]);
  assert.equal(packageJson.exports["./host"], undefined);
  assert.ok(packageJson.exports["./client"]);
  assert.ok(packageJson.dsh.client);
});

test("标题栏只在能力探测确认账本候选后显示余额入口", async () => {
  let registration: { factory: (require: (name: string) => unknown) => { apply: (context: unknown) => void; inject: string[] } } | undefined;
  const source = await readFile(new URL("../../dist/src/client.bundle.cjs", import.meta.url), "utf8"); const effects: Array<() => unknown> = [];
  const react = {
    createElement: (type: unknown, props: Record<string, unknown>) => typeof type === "function" ? (type as (value: Record<string, unknown>) => unknown)(props) : { type, props },
    useEffect: (effect: () => unknown) => { effects.push(effect); },
    useState: () => [0, () => undefined],
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useCallback: <T>(callback: T) => callback,
    useRef: () => ({ current: null }),
  };
  const dictionaries: Map<string, Record<string, string>> = new Map();
  const document = { visibilityState: "visible", getElementById: () => null, createElement: () => ({ id: "", textContent: "" }), head: { append: () => undefined } };
  runInNewContext(source, { window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value; } }, localStorage: { getItem: () => null, setItem: () => undefined } }, document, AbortController, setTimeout: () => 1, clearTimeout: () => undefined });
  const exports = registration!.factory((name) => name === "react" ? react : undefined);
  assert.ok(exports.inject.includes("locale"), "客户端 bundle 未声明 locale 服务注入");
  let registeredLocale: unknown;
  const locale = {
    register: (namespace: string, dicts: Record<string, Record<string, string>>) => { dictionaries.set(namespace, dicts.zh); registeredLocale = namespace; return () => undefined; },
    bind: (namespace: string) => (key: string, params: Record<string, unknown>) => (dictionaries.get(namespace)?.[key] ?? key).replace(/\{(\w+)\}/gu, (whole: string, name: string) => String(params?.[name] ?? whole)),
    subscribe: () => () => undefined,
    getLocale: () => ({ active: "zh", locales: [], revision: 0 }),
  };
  let render: ((props: Record<string, unknown>) => unknown) | undefined;
  exports.apply({
    connection: { rpc: { call: async (_channel: string, endpoint: string, payload: { sessionId: string }) => ({ ok: true, value: { ok: true, value: endpoint === "capability" ? { candidate: payload.sessionId === "ledger" } : undefined } }) } },
    slots: { inject: (_name: string, callback: () => unknown) => callback(), register: (definition: { id?: string }, value: typeof render) => { if (definition.id === "dsh-moneypal-balance") render = value; } },
    effect: (callback: () => () => void) => callback(),
    locale,
  });
  assert.equal(registeredLocale, "dsh-moneypal.balance", "客户端未注册 locale 命名空间");
  assert.ok(dictionaries.get("dsh-moneypal.balance")?.["entry.aria"], "locale 字典缺少入口文案");
  assert.equal(render!({ sessionId: "ledger" }), null);
  for (const effect of effects.splice(0)) effect(); await new Promise((resolve) => setImmediate(resolve));
  const entry = render!({ sessionId: "ledger" }) as { type?: string; props?: { "aria-label"?: string; "aria-expanded"?: boolean; "aria-controls"?: string } } | null;
  assert.equal(entry?.type, "button");
  assert.equal(entry?.props?.["aria-label"], "查看账户余额");
  assert.equal(entry?.props?.["aria-expanded"], false);
  assert.equal(entry?.props?.["aria-controls"], "dsh-moneypal-balance-drawer");
  for (const effect of effects.splice(0)) effect(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(render!({ sessionId: "ordinary" }), null);
});

test("余额 RPC 排除未来日期，保留精度并按资产负债分组", async () => {
  const ledger = await workspace("balances"); const service = rpc(new Map([["ledger", { header: { cwd: ledger } }]]));
  const result = await service.call("balances", { sessionId: "ledger", asOf: "2026-08-27" }) as { ok: true; value: { ok: true; value: { assets: { accounts: Array<{ account: string; amounts: Array<{ quantity: string }> }> }; liabilities: { accounts: Array<{ account: string }> } } } };
  assert.equal(result.value.ok, true); assert.deepEqual(result.value.value.assets.accounts.map((account) => account.account), ["Assets:C-现金"]);
  assert.deepEqual(result.value.value.assets.accounts[0]?.amounts[0], { commodity: "CNY", quantity: "1234.500" });
  assert.deepEqual(result.value.value.liabilities.accounts.map((account) => account.account), ["Liabilities:C-信用卡"]);
});

test("余额快照使用固定、大小写精确的根账户", async () => {
  const ledger = await workspace("fixed-roots");
  const snapshot = await readBalanceSnapshot(ledger, "2026-08-27");
  assert.deepEqual(snapshot.assets.accounts.map((account) => account.account), ["Assets:C-现金"]);
  assert.deepEqual(snapshot.liabilities.accounts.map((account) => account.account), ["Liabilities:C-信用卡"]);
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

test("日期与金额格式使用精确整数，而非浮点数", () => {
  assert.equal(dayAfter("2026-12-31"), "2027-01-01");
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12345678901234567.89" }), "12,345,678,901,234,567.89 CNY");
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12.34" }, true), "-12.34 CNY");
  // 超出安全整数范围与超过 20 位小数：逐字保留，不丢位、不舍入
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12345678901234567890123456789.00" }), "12,345,678,901,234,567,890,123,456,789.00 CNY");
  assert.equal(formatAmount({ commodity: "CNY", quantity: "0.123456789012345678901234567890" }), "0.123456789012345678901234567890 CNY");
  // 中英文 locale 均保留精度与分组；缺省参数回退中文
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12345678901234567.89" }, false, "en-US"), "12,345,678,901,234,567.89 CNY");
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12345678901234567.89" }, false, "zh-CN"), "12,345,678,901,234,567.89 CNY");
});

test("金额拆分为数值、币种与负值标记，供界面分别排版", () => {
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "12345678901234567.89" }), { value: "12,345,678,901,234,567.89", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "-12.34" }), { value: "-12.34", currency: "CNY", negative: true });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "-12.34" }, true), { value: "12.34", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "USD", quantity: "120.00" }, true), { value: "-120.00", currency: "USD", negative: true });
  // 尾随零逐字保留；负资产与负债取反语义不变
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "0.30" }), { value: "0.30", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "100.00" }), { value: "100.00", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "-500.00" }), { value: "-500.00", currency: "CNY", negative: true });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "-1200.00" }, true), { value: "1,200.00", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "50.00" }, true), { value: "-50.00", currency: "CNY", negative: true });
  assert.equal(formatAmount({ commodity: "CNY", quantity: "-12.34" }), "-12.34 CNY");
});

test("抽屉样式全部限定在插件命名空间，并由构建脚本嵌入客户端 bundle", async () => {
  const css = await readFile(new URL("../../src/client.css", import.meta.url), "utf8");
  const namespace = ".dsh-moneypal-balance";
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  let buffer = ""; const atRules: boolean[] = []; let checked = 0;
  for (const character of stripped) {
    if (character === "{") {
      const selector = buffer.trim(); buffer = "";
      atRules.push(selector.startsWith("@"));
      if (!selector.startsWith("@")) {
        for (const part of selector.split(",")) {
          assert.ok(part.trim().startsWith(namespace), `选择器超出命名空间：${part.trim()}`);
          checked += 1;
        }
      }
      continue;
    }
    if (character === "}") { atRules.pop(); buffer = ""; continue; }
    buffer += character;
  }
  assert.ok(checked >= 30, "样式规则数量异常");
  const bundle = await readFile(new URL("../../dist/src/client.bundle.cjs", import.meta.url), "utf8");
  assert.ok(bundle.includes("--dsh-moneypal-balance-surface"), "bundle 未嵌入命名空间样式");
  assert.ok(!bundle.includes("__CLIENT_STYLES__"), "bundle 仍保留样式占位符");
});

test("余额抽屉只消费领域余额 DTO，保留完整中文账户名和多币种", () => {
  assert.deepEqual(snapshotFromBalance("2026-08-27", {
    range: { begin: null, end: "2026-08-28" },
    accounts: [
      { account: "Assets:C-支付宝", amounts: [{ commodity: "CNY", quantity: "12345678901234567.89" }, { commodity: "USD", quantity: "0.3" }] },
      { account: "Liabilities:C-信用卡", amounts: [{ commodity: "CNY", quantity: "-12.34" }] },
      { account: "Expenses:C-餐饮", amounts: [{ commodity: "CNY", quantity: "12.34" }] },
    ],
    totals: [],
  }), {
    asOf: "2026-08-27",
    assets: {
      accounts: [{ account: "Assets:C-支付宝", amounts: [{ commodity: "CNY", quantity: "12345678901234567.89" }, { commodity: "USD", quantity: "0.3" }] }],
      totals: [{ commodity: "CNY", quantity: "12345678901234567.89" }, { commodity: "USD", quantity: "0.3" }],
    },
    liabilities: {
      accounts: [{ account: "Liabilities:C-信用卡", amounts: [{ commodity: "CNY", quantity: "-12.34" }] }],
      totals: [{ commodity: "CNY", quantity: "-12.34" }],
    },
  });
});

test("客户端控制器切换会话时取消旧请求，并只持久化开关", async () => {
  let oldAborted = false; const saved: string[] = [];
  const controller = new BalanceController({ storage: { getItem: () => null, setItem: (key, value) => saved.push(`${key}:${value}`) }, visible: () => true, rpc: {
    capability: async () => true,
    balances: async (id, _date, signal) => { if (id === "old") { await new Promise((resolve) => signal.addEventListener("abort", () => { oldAborted = true; resolve(undefined); })); throw new Error("cancelled"); } return { asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } }; },
  } });
  await controller.setSession("old"); const pending = controller.toggle(true); await controller.setSession("new"); await pending;
  await controller.toggle(false); await controller.toggle(true); controller.dispose();
  assert.equal(oldAborted, true); assert.equal(controller.state.sessionId, "new");
  assert.deepEqual(saved, ["dsh-moneypal.balance-open:true", "dsh-moneypal.balance-open:false", "dsh-moneypal.balance-open:true"]);
});

test("冷会话按退避重试，候选账本打开后轮询余额并保留过期快照", async () => {
  const timers: Array<{ callback: () => void; ms: number }> = []; let attempts = 0; let balances = 0;
  const controller = new BalanceController({ now: () => new Date("2026-08-29T23:59:59+08:00"), visible: () => true, schedule: (callback, ms) => { timers.push({ callback, ms }); return timers.length as unknown as ReturnType<typeof setTimeout>; }, cancel: () => undefined, rpc: {
    capability: async () => { attempts += 1; if (attempts <= 3) throw new BalanceClientError("session_unavailable", "稍后重试"); return true; },
    balances: async () => { balances += 1; if (balances > 1) throw new Error("transport"); return { asOf: "2026-08-29", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } }; },
  } });
  await controller.setSession("cold");
  for (const delay of [250, 500, 1_000]) { assert.equal(timers.at(-1)?.ms, delay); timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve)); }
  assert.equal(controller.state.capability, "candidate"); await controller.toggle(true);
  assert.equal(controller.state.snapshot?.asOf, "2026-08-29"); assert.equal(timers.at(-1)?.ms, 30_000);
  timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.stale, true); assert.equal(controller.state.error, "暂时无法读取账户余额，请重试。"); controller.dispose();
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

test("重开抽屉与页面恢复时旧快照标记待更新，刷新成功后解除", async () => {
  let fail = false;
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [{ commodity: "CNY", quantity: "1.00" }] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => true,
    balances: async () => { if (fail) throw new Error("transport"); return snapshot; },
  } });
  await controller.setSession("s"); await controller.toggle(true);
  assert.equal(controller.state.stale, false);
  await controller.toggle(false);
  const reopening = controller.toggle(true);
  assert.equal(controller.state.stale, true, "重开抽屉未把旧快照标记为待更新");
  await reopening;
  assert.equal(controller.state.stale, false);
  fail = true; await controller.refresh();
  assert.equal(controller.state.stale, true);
  fail = false;
  controller.visibleChanged();
  assert.equal(controller.state.stale, true, "页面恢复未把旧快照标记为待更新");
  await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.stale, false);
  controller.dispose();
});

test("能力探测失败立即呈现可重试状态，重试成功后恢复", async () => {
  let fail = true;
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => { if (fail) throw new BalanceClientError("balance_unavailable", "连接不可用"); return true; },
    balances: async () => snapshot,
  } });
  await controller.setSession("s");
  assert.equal(controller.state.capability, "unknown");
  assert.equal(controller.state.probeError, "连接不可用", "探测失败未呈现可重试状态");
  assert.equal(controller.state.loading, false, "探测失败后不得停留在加载状态");
  fail = false;
  await controller.retry();
  assert.equal(controller.state.capability, "candidate");
  assert.equal(controller.state.probeError, undefined);
  controller.dispose();
});

test("冷会话退避期间保持加载骨架，退避耗尽后呈现可重试状态", async () => {
  const timers: Array<{ callback: () => void; ms: number }> = []; let attempts = 0;
  const controller = new BalanceController({ visible: () => true, schedule: (callback, ms) => { timers.push({ callback, ms }); return timers.length as unknown as ReturnType<typeof setTimeout>; }, cancel: () => undefined, rpc: {
    capability: async () => { attempts += 1; throw new BalanceClientError("session_unavailable", "稍后重试"); },
    balances: async () => ({ asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } }),
  } });
  await controller.setSession("cold");
  assert.equal(controller.state.probeError, undefined, "快速退避期间不应提前呈现错误");
  timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
  timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.probeError, undefined, "退避未耗尽时不应呈现错误");
  timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 4);
  assert.ok(controller.state.probeError, "退避耗尽后未呈现可重试状态");
  controller.dispose();
});

test("探测失败时已有快照标记待更新；候选转普通工作区时关闭抽屉并清空快照", async () => {
  let candidate = true; let failCapability = false;
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [{ commodity: "CNY", quantity: "1.00" }] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => { if (failCapability) throw new BalanceClientError("balance_unavailable", "断开"); return candidate; },
    balances: async () => snapshot,
  } });
  await controller.setSession("s"); await controller.toggle(true);
  assert.ok(controller.state.snapshot);
  failCapability = true; await controller.probe();
  assert.equal(controller.state.stale, true, "探测失败未把已有快照标记为待更新");
  failCapability = false; candidate = false; await controller.probe();
  assert.equal(controller.state.capability, "ordinary");
  assert.equal(controller.state.open, false);
  assert.equal(controller.state.snapshot, undefined, "转普通工作区未清空旧快照");
  assert.equal(controller.state.error, undefined);
  assert.equal(controller.state.probeError, undefined);
  controller.dispose();
});

test("localStorage 异常时开关持久化降级，不影响余额流程", async () => {
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, storage: throwing, rpc: { capability: async () => true, balances: async () => snapshot } });
  await controller.setSession("s");
  await controller.toggle(true);
  assert.equal(controller.state.open, true);
  assert.ok(controller.state.snapshot, "存储异常不应阻断余额读取");
  await controller.toggle(false);
  assert.equal(controller.state.open, false);
  controller.dispose();
});

test("未知会话可关闭抽屉并保留后台探测；失败恢复打开不请求余额，重复打开直接返回", async () => {
  const timers: Array<{ callback: () => void; ms: number }> = []; const saved: string[] = [];
  let mode: "cold" | "fail" | "ok" = "cold"; let balances = 0;
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, storage: { getItem: () => null, setItem: (key, value) => saved.push(`${key}:${value}`) }, schedule: (callback, ms) => { timers.push({ callback, ms }); return timers.length as unknown as ReturnType<typeof setTimeout>; }, cancel: () => undefined, rpc: {
    capability: async () => { if (mode === "cold") throw new BalanceClientError("session_unavailable", "稍后重试"); if (mode === "fail") throw new BalanceClientError("balance_unavailable", "断开"); return true; },
    balances: async () => { balances += 1; return snapshot; },
  } });
  await controller.setSession("s");
  assert.equal(controller.state.capability, "unknown");
  assert.equal(controller.state.probeError, undefined, "冷退避期间不呈现错误");
  await controller.toggle(true);
  assert.equal(controller.state.open, false, "冷退避期间打开是 no-op");
  assert.equal(balances, 0);

  // 非冷失败后的恢复打开：只展示既有错误并保存打开偏好，不请求余额、不清错误、不进加载态
  mode = "fail"; await controller.retry();
  assert.equal(controller.state.probeError, "断开");
  await controller.toggle(true);
  assert.equal(controller.state.open, true);
  assert.equal(controller.state.loading, false, "失败态打开不得进入加载态");
  assert.equal(controller.state.probeError, "断开", "失败态打开不得清除错误");
  assert.equal(balances, 0, "失败态打开不得请求余额");

  // 已打开时重复打开直接返回，不重复写偏好
  const writesBefore = saved.length;
  await controller.toggle(true);
  assert.equal(saved.length, writesBefore, "重复打开不得重复写偏好");
  assert.equal(controller.state.open, true);

  // 未知能力下允许关闭：写关闭偏好、清加载，后台能力探测保留
  await controller.toggle(false);
  assert.equal(controller.state.open, false);
  assert.equal(controller.state.loading, false);
  assert.equal(timers.at(-1)?.ms, 30_000, "关闭后应保留后台能力探测");
  assert.deepEqual(saved, ["dsh-moneypal.balance-open:true", "dsh-moneypal.balance-open:false"]);

  // 后台探测确认候选后重新打开：正常读取余额
  mode = "ok";
  timers.at(-1)?.callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.capability, "candidate");
  await controller.toggle(true);
  assert.equal(balances, 1);
  assert.ok(controller.state.snapshot);
  controller.dispose();
});

test("重试确认为候选时自动补拉余额，确认为普通时关闭抽屉并清空快照", async () => {
  let mode: "fail" | "ok" | "ordinary" = "fail"; let balances = 0;
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [{ commodity: "CNY", quantity: "1.00" }] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => { if (mode === "fail") throw new BalanceClientError("balance_unavailable", "断开"); return mode !== "ordinary"; },
    balances: async () => { balances += 1; return snapshot; },
  } });
  await controller.setSession("s");
  await controller.toggle(true);
  assert.equal(controller.state.probeError, "断开");
  mode = "ok"; await controller.retry();
  assert.equal(controller.state.capability, "candidate");
  assert.equal(controller.state.probeError, undefined, "重试成功应清除错误");
  assert.equal(balances, 1, "重试确认为候选后应由探测路径自动补拉余额");
  assert.ok(controller.state.snapshot);
  mode = "ordinary"; await controller.retry();
  assert.equal(controller.state.capability, "ordinary");
  assert.equal(controller.state.open, false, "重试确认为普通后应关闭抽屉");
  assert.equal(controller.state.snapshot, undefined, "重试确认为普通后应清空快照");
  assert.equal(controller.state.probeError, undefined);
  controller.dispose();
});

test("重试期间冷退避保持加载、耗尽后呈现错误", async () => {
  const timers: Array<{ callback: () => void; ms: number }> = [];
  let mode: "cold" | "fail" | "ok" = "ok";
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, schedule: (callback, ms) => { timers.push({ callback, ms }); return timers.length as unknown as ReturnType<typeof setTimeout>; }, cancel: () => undefined, rpc: {
    capability: async () => { if (mode === "fail") throw new BalanceClientError("balance_unavailable", "断开"); if (mode === "cold") throw new BalanceClientError("session_unavailable", "稍后重试"); return true; },
    balances: async () => snapshot,
  } });
  await controller.setSession("s"); await controller.toggle(true);
  assert.equal(controller.state.capability, "candidate");
  assert.ok(controller.state.snapshot);

  // 先进入可重试状态（非冷失败），再手动重试
  mode = "fail"; await controller.probe();
  assert.equal(controller.state.probeError, "断开");
  mode = "cold";
  await controller.retry();
  assert.equal(controller.state.loading, true, "重试应让已打开的抽屉进入加载态");
  assert.equal(controller.state.snapshot?.asOf, "2026-08-27", "重试期间应保留旧快照");
  assert.equal(controller.state.stale, true, "重试应保留旧快照的过期标记");

  // 重试后的探测继续冷退避：已打开的抽屉保持加载，退避节奏为 250/500/1000
  assert.equal(timers.at(-1)?.ms, 250);
  timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.loading, true, "冷退避期间已打开的抽屉应保持加载");
  assert.equal(controller.state.probeError, undefined, "退避期间不得呈现错误");
  timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.loading, true, "退避未耗尽时应保持加载");
  timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
  assert.ok(controller.state.probeError, "退避耗尽后应呈现错误");
  assert.equal(controller.state.loading, false, "退避耗尽后应结束加载");
  assert.equal(controller.state.snapshot?.asOf, "2026-08-27", "错误期间仍保留旧快照");
  controller.dispose();
});

test("切换会话后迟到的余额结果不得污染新会话", async () => {
  let release!: (value: BalanceSnapshot | PromiseLike<BalanceSnapshot>) => void;
  const oldSnapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-旧会话", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const newSnapshot = { asOf: "2026-08-28", assets: { accounts: [{ account: "Assets:C-新会话", amounts: [{ commodity: "CNY", quantity: "2.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => true,
    balances: async (id) => id === "old" ? new Promise((resolve) => { release = resolve; }) : newSnapshot,
  } });
  await controller.setSession("old");
  const pending = controller.toggle(true);
  await controller.setSession("new");
  release(oldSnapshot);
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.sessionId, "new");
  assert.equal(controller.state.snapshot?.asOf, "2026-08-28", "应展示新会话快照");
  assert.equal(JSON.stringify(controller.state.snapshot).includes("旧会话"), false, "迟到的旧会话结果不得进入状态");
  controller.dispose();
});

test("页脚状态模型按优先级逐行给出文案键与圆点类型", () => {
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const emptySnapshot = { asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const base = { error: undefined, probeError: undefined, loading: false, stale: false, snapshot: undefined };
  // 表格逐行：错误 → 加载（有/无快照）→ 过期 → 空数据 → 新鲜 → 兜底
  assert.deepEqual(footerStatus({ ...base, error: "读取余额失败", snapshot }), { key: "status.refreshFailed", dot: "warning" });
  assert.deepEqual(footerStatus({ ...base, probeError: "断开", snapshot }), { key: "status.refreshFailed", dot: "warning" });
  assert.deepEqual(footerStatus({ ...base, loading: true, snapshot }), { key: "status.refreshing", dot: "neutral" });
  assert.deepEqual(footerStatus({ ...base, loading: true }), { key: "status.waitingLedger", dot: "neutral" });
  assert.deepEqual(footerStatus({ ...base, stale: true, snapshot }), { key: "status.stale", dot: "warning" });
  assert.deepEqual(footerStatus({ ...base, snapshot: emptySnapshot }), { key: "status.noData", dot: "neutral" });
  assert.deepEqual(footerStatus({ ...base, snapshot }), { key: "status.autoRefresh", dot: "success" });
  assert.deepEqual(footerStatus(base), { key: "status.waitingLedger", dot: "neutral" });
});

test("概览预览选择：单商品按绝对金额降序取前三，其余保持原顺序且不改快照", () => {
  const asSnapshot = (value: unknown) => value as Parameters<typeof selectPreviewAccounts>[0];
  const build = (assets: Array<[string, string[]]>, liabilities: Array<[string, string[]]> = []) => ({
    asOf: "2026-08-27",
    assets: { accounts: assets.map(([account, quantities]) => ({ account, amounts: quantities.map((quantity) => ({ commodity: "CNY", quantity })) })), totals: [] },
    liabilities: { accounts: liabilities.map(([account, quantities]) => ({ account, amounts: quantities.map((quantity) => ({ commodity: "CNY", quantity })) })), totals: [] },
  });

  // 同币种正负金额、大数、不同小数位：按绝对金额降序取前三
  const mixed = asSnapshot(build([["Assets:A", ["100.00"]], ["Assets:B", ["-1200.00"]], ["Assets:C", ["300.00"]], ["Assets:D", ["123456789012345678901234567890.00"]]]));
  const frozen = JSON.stringify(mixed);
  const preview = selectPreviewAccounts(mixed);
  assert.deepEqual(preview.map((entry) => entry.account.account), ["Assets:D", "Assets:B", "Assets:C"], "应按绝对金额降序取前三");
  assert.deepEqual(preview.map((entry) => entry.liability), [false, false, false]);
  assert.equal(JSON.stringify(mixed), frozen, "预览选择不得修改快照");

  // 负债参与降序；绝对值相等（含小数位差异）时保留原顺序
  const ties = asSnapshot(build([["Assets:A", ["0.30"]], ["Assets:B", ["0.3"]]], [["Liabilities:E", ["-50.00"]], ["Liabilities:F", ["50.000"]]]));
  const tiesPreview = selectPreviewAccounts(ties);
  assert.deepEqual(tiesPreview.map((entry) => entry.account.account), ["Liabilities:E", "Liabilities:F", "Assets:A"], "相等金额保留原顺序，负债按绝对值参与排序");
  assert.deepEqual(tiesPreview.map((entry) => entry.liability), [true, true, false]);

  // 多商品出现在第四个账户：不排序
  const multiFourth = build([["Assets:A", ["1.00"]], ["Assets:B", ["5.00"]], ["Assets:C", ["3.00"]], ["Assets:D", ["2.00"]]]);
  (multiFourth.assets.accounts[3]!.amounts as Array<{ commodity: string; quantity: string }>).push({ commodity: "USD", quantity: "1.00" });
  assert.deepEqual(selectPreviewAccounts(asSnapshot(multiFourth)).map((entry) => entry.account.account), ["Assets:A", "Assets:B", "Assets:C"], "第四个账户出现第二商品即不排序");

  // 单商品但某账户有第二条金额：不排序
  const multiSecond = build([["Assets:A", ["5.00"]], ["Assets:B", ["1.00"]]]);
  (multiSecond.assets.accounts[0]!.amounts as Array<{ commodity: string; quantity: string }>).push({ commodity: "CNY", quantity: "2.00" });
  assert.deepEqual(selectPreviewAccounts(asSnapshot(multiSecond)).map((entry) => entry.account.account), ["Assets:A", "Assets:B"], "任一账户出现第二条金额即不排序");

  // 无商品与空账户金额：不排序，返回原顺序前若干条
  assert.deepEqual(selectPreviewAccounts(asSnapshot(build([]))), []);
  const emptyAmounts = build([["Assets:A", []], ["Assets:B", ["5.00"]]]);
  assert.deepEqual(selectPreviewAccounts(asSnapshot(emptyAmounts)).map((entry) => entry.account.account), ["Assets:A", "Assets:B"], "金额结构不满足时保持原顺序");
});
