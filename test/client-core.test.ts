import assert from "node:assert/strict";
import { test } from "node:test";

import { dayAfter, snapshotFromBalance, type BalanceSnapshot } from "../src/balance.js";
import { BalanceClientError, BalanceController, formatAmount, formatAmountParts } from "../src/client.js";

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

test("冷会话按 100/150/250/400/700 退避重试，挂载完成后转入 30 秒轮询", async () => {
  const timers: Array<{ callback: () => void; ms: number }> = []; let attempts = 0;
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, schedule: (callback, ms) => { timers.push({ callback, ms }); return timers.length as unknown as ReturnType<typeof setTimeout>; }, cancel: () => undefined, rpc: {
    capability: async () => { attempts += 1; if (attempts <= 5) throw new BalanceClientError("session_unavailable", "稍后重试"); return true; },
    balances: async () => snapshot,
  } });
  await controller.setSession("cold");
  assert.equal(controller.state.probeError, undefined, "快速退避期间不应提前呈现错误");
  for (const delay of [100, 150, 250, 400, 700]) {
    assert.equal(timers.at(-1)?.ms, delay);
    timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.state.probeError, undefined, "退避未耗尽时不应呈现错误");
  }
  assert.equal(attempts, 6, "前五次冷失败、第六次成功");
  assert.equal(controller.state.capability, "candidate");
  await controller.toggle(true);
  assert.ok(controller.state.snapshot, "候选确认后应自动补拉余额");
  assert.equal(timers.at(-1)?.ms, 30_000, "成功后应转入 30 秒轮询");
  controller.dispose();
});

test("冷会话退避耗尽后呈现可重试状态并结束加载", async () => {
  const backoff = [100, 150, 250, 400, 700];
  const timers: Array<{ callback: () => void; ms: number }> = []; let attempts = 0;
  const controller = new BalanceController({ visible: () => true, schedule: (callback, ms) => { timers.push({ callback, ms }); return timers.length as unknown as ReturnType<typeof setTimeout>; }, cancel: () => undefined, rpc: {
    capability: async () => { attempts += 1; throw new BalanceClientError("session_unavailable", "稍后重试"); },
    balances: async () => ({ asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } }),
  } });
  await controller.setSession("cold");
  for (let index = 0; index < backoff.length - 1; index += 1) {
    timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.state.probeError, undefined, "退避未耗尽时不应呈现错误");
  }
  timers.at(-1)?.callback(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, backoff.length + 1);
  assert.ok(controller.state.probeError, "退避耗尽后未呈现可重试状态");
  assert.equal(controller.state.loading, false, "退避耗尽后应结束加载");
  controller.dispose();
});

test("候选降级为普通时取消在途余额请求，迟到的结果不得写回快照", async () => {
  let release!: (value: BalanceSnapshot | PromiseLike<BalanceSnapshot>) => void;
  let candidate = true;
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => candidate,
    balances: async () => new Promise((resolve) => { release = resolve; }),
  } });
  await controller.setSession("s");
  const pending = controller.toggle(true);
  assert.equal(controller.state.loading, true, "余额请求在途时应处于加载状态");
  candidate = false;
  await controller.probe();
  assert.equal(controller.state.capability, "ordinary");
  assert.equal(controller.state.open, false, "降级后应关闭抽屉");
  assert.equal(controller.state.loading, false, "降级后应结束加载");
  release(snapshot);
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.state.snapshot, undefined, "迟到的余额结果不得写回已降级的会话");
  controller.dispose();
});

test("会话能力缓存：切回已确认会话立即恢复能力并后台复探", async () => {
  let probes = 0;
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => { probes += 1; return true; },
    balances: async () => snapshot,
  } });
  await controller.setSession("a");
  await controller.setSession("b");
  const switching = controller.setSession("a");
  assert.equal(controller.state.capability, "candidate", "切回已确认会话应立即恢复缓存能力，入口可立即显示");
  await switching;
  assert.equal(controller.state.capability, "candidate");
  assert.equal(probes, 3, "恢复缓存后仍应后台复探确认");
  controller.dispose();
});

test("会话能力缓存：恢复普通会话立即关闭抽屉且不改写偏好，复探候选后按偏好补开", async () => {
  const written: Array<[string, string]> = [];
  const storage = { getItem: (key: string) => written.find(([name]) => name === key)?.[1] ?? null, setItem: (key: string, value: string) => { written.push([key, value]); } };
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, storage, rpc: {
    capability: async (id) => id !== "plain",
    balances: async () => snapshot,
  } });
  await controller.setSession("ledger");
  await controller.toggle(true);
  await controller.setSession("plain");
  assert.equal(controller.state.capability, "ordinary");
  await controller.setSession("ledger");
  assert.equal(controller.state.open, true, "复探候选后应按打开偏好补开抽屉");
  const switching = controller.setSession("plain");
  assert.equal(controller.state.capability, "ordinary", "恢复普通会话应立即呈现缓存能力");
  assert.equal(controller.state.open, false, "恢复普通会话应立即关闭抽屉");
  assert.equal(controller.state.loading, false);
  await switching;
  assert.deepEqual(written, [["dsh-moneypal.balance-open", "true"]], "恢复路径不得改写打开偏好");
  controller.dispose();
});

test("会话能力缓存：缓存陈旧时由复探纠正为普通并清空快照", async () => {
  let ledgerExists = true;
  const snapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async (id) => id === "ledger" ? ledgerExists : true,
    balances: async () => snapshot,
  } });
  await controller.setSession("ledger"); await controller.toggle(true);
  assert.ok(controller.state.snapshot);
  await controller.toggle(false);
  ledgerExists = false;
  await controller.setSession("other");
  const switching = controller.setSession("ledger");
  assert.equal(controller.state.capability, "candidate", "恢复时先呈现缓存能力");
  await switching;
  assert.equal(controller.state.capability, "ordinary", "复探应纠正陈旧缓存");
  assert.equal(controller.state.snapshot, undefined, "纠正后应清空旧快照");
  assert.equal(controller.state.open, false);
  controller.dispose();
});
