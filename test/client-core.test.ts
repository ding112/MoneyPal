import assert from "node:assert/strict";
import { test } from "node:test";

import { dayAfter, snapshotFromBalance, type BalanceSnapshot } from "../src/balance.js";
import { BalanceClientError, BalanceController, formatAmount, formatAmountParts } from "../src/client.js";

const MP = "dsh-moneypal";
const OPEN_KEY = "dsh-moneypal.balance-open";
const COLD_RETRIES = [100, 150, 250, 400, 700];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const cashSnapshot = (): BalanceSnapshot => ({ asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [{ commodity: "CNY", quantity: "1.00" }] }, liabilities: { accounts: [], totals: [] } });
const emptySnapshot = (): BalanceSnapshot => ({ asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } });
const readonlyStorage = (value: string | null) => ({ getItem: (key: string) => (key === OPEN_KEY ? value : null), setItem: () => undefined });
const recordingStorage = () => {
  const written: Array<[string, string]> = [];
  return { written, storage: { getItem: (key: string) => written.find(([name]) => name === key)?.[1] ?? null, setItem: (key: string, value: string) => { written.push([key, value]); } } };
};
/** 可注入定时器夹具：cancel 只标记不触发，fire 跳过已取消的定时器，模拟真实 clearTimeout 语义。 */
function timerSpy() {
  const timers: Array<{ callback: () => void; ms: number; canceled: boolean }> = [];
  return {
    schedule: (callback: () => void, ms: number) => { const timer = { callback, ms, canceled: false }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; },
    cancel: (timer: ReturnType<typeof setTimeout>) => { (timer as unknown as { canceled: boolean }).canceled = true; },
    lastLive: () => [...timers].reverse().find((timer) => !timer.canceled),
    fire: async (timer: { callback: () => void; canceled: boolean }) => { if (timer.canceled) return; timer.canceled = true; timer.callback(); await flush(); },
  };
}

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

test("桌面进入 MoneyPal 会话无偏好时默认展开，能力确认后读取余额", async () => {
  let balances = 0;
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => true,
    balances: async () => { balances += 1; return cashSnapshot(); },
  } });
  try {
    await controller.setSession("s", MP);
    assert.equal(controller.state.open, true, "桌面无历史偏好应默认展开");
    assert.equal(controller.state.capability, "candidate");
    await flush();
    assert.equal(balances, 1, "能力确认后应恰好读取一次余额");
    assert.ok(controller.state.snapshot);
    assert.equal(controller.state.loading, false);
  } finally { controller.dispose(); }
});

test("关闭偏好下探测照常但不读取余额，轮询与重连不得重开", async () => {
  let balances = 0;
  const { schedule, cancel, lastLive, fire } = timerSpy();
  const controller = new BalanceController({ visible: () => true, storage: readonlyStorage("false"), schedule, cancel, rpc: {
    capability: async () => true,
    balances: async () => { balances += 1; return emptySnapshot(); },
  } });
  try {
    await controller.setSession("s", MP);
    assert.equal(controller.state.open, false);
    assert.equal(controller.state.capability, "candidate");
    assert.equal(balances, 0, "关闭偏好下不得读取余额");
    // 30 秒轮询后同样不重开、不读余额
    assert.equal(lastLive()?.ms, 30_000);
    await fire(lastLive()!);
    assert.equal(controller.state.open, false);
    assert.equal(balances, 0);
    // 重连（页面恢复）同样不重开
    controller.visibleChanged();
    await flush(); await flush();
    assert.equal(controller.state.open, false);
    assert.equal(balances, 0);
  } finally { controller.dispose(); }
});

test("true 偏好桌面自动展开；手机不展开，切回桌面按偏好恢复并重新获取", async () => {
  let balances = 0;
  const controller = new BalanceController({ visible: () => true, storage: readonlyStorage("true"), rpc: {
    capability: async () => true,
    balances: async () => { balances += 1; return cashSnapshot(); },
  } });
  try {
    await controller.setSession("s", MP);
    assert.equal(controller.state.open, true);
    await flush();
    assert.equal(balances, 1);
    // 手机进入即收起，不继续读取余额，但保留同一会话快照
    await controller.setSession("s", MP, true);
    assert.equal(controller.state.open, false);
    assert.equal(balances, 1, "手机收起后不得继续读取余额");
    assert.ok(controller.state.snapshot, "屏幕切换不清空同一会话快照");
    // 切回桌面：按偏好恢复，旧快照标记待更新并重新获取
    await controller.setSession("s", MP, false);
    assert.equal(controller.state.open, true);
    await flush();
    assert.equal(balances, 2);
    assert.equal(controller.state.stale, false);
  } finally { controller.dispose(); }
});

test("preset 缺失或非精确 dsh-moneypal 时不发出任何 RPC", async () => {
  let calls = 0;
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => { calls += 1; return true; },
    balances: async () => { calls += 1; return emptySnapshot(); },
  } });
  try {
    await controller.setSession("s");
    await controller.setSession("s", "standard");
    await controller.setSession("s", "moneypal");
    await controller.setSession("s", "DSH-MONEYPAL");
    assert.equal(calls, 0, "preset 未确定或大小写不匹配时不得发起 RPC");
    assert.equal(controller.state.open, false);
    assert.equal(controller.state.snapshot, undefined);
    // 精确匹配后才开始探测
    await controller.setSession("s", MP);
    assert.ok(calls > 0);
  } finally { controller.dispose(); }
});

test("preset 延迟变为 dsh-moneypal 后按首次进入处理", async () => {
  let balances = 0;
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => true,
    balances: async () => { balances += 1; return cashSnapshot(); },
  } });
  try {
    await controller.setSession("s");
    assert.equal(controller.state.open, false);
    const switching = controller.setSession("s", MP);
    assert.equal(controller.state.open, true, "桌面进入 MoneyPal 即按偏好默认展开");
    await switching;
    await flush();
    assert.equal(controller.state.capability, "candidate");
    assert.ok(controller.state.snapshot);
    assert.equal(balances, 1);
  } finally { controller.dispose(); }
});

test("能力降级为普通时抽屉保持打开并清空余额，重试确认后恢复读取", async () => {
  let candidate = true;
  let release!: (value: BalanceSnapshot | PromiseLike<BalanceSnapshot>) => void;
  let balanceCalls = 0;
  const snapshot = cashSnapshot();
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => candidate,
    balances: async () => { balanceCalls += 1; return balanceCalls === 1 ? new Promise<BalanceSnapshot>((resolve) => { release = resolve; }) : snapshot; },
  } });
  try {
    await controller.setSession("s", MP);
    assert.equal(controller.state.open, true);
    assert.equal(controller.state.loading, true, "余额请求在途时应处于加载状态");
    candidate = false;
    await controller.probe();
    assert.equal(controller.state.capability, "ordinary");
    assert.equal(controller.state.open, true, "降级后抽屉保持打开");
    assert.equal(controller.state.loading, false, "降级后应结束加载");
    assert.equal(controller.state.snapshot, undefined, "降级后应清空旧快照");
    release(snapshot);
    await flush();
    assert.equal(controller.state.snapshot, undefined, "迟到的余额结果不得写回已降级的会话");
    candidate = true;
    await controller.retry();
    assert.equal(controller.state.capability, "candidate");
    await flush();
    assert.ok(controller.state.snapshot, "重试成功后应恢复读取余额");
  } finally { controller.dispose(); }
});

test("探测失败不改变打开状态，冷退避耗尽后呈现错误并结束加载", async () => {
  let cold = false;
  let attempts = 0;
  const { schedule, cancel, lastLive, fire } = timerSpy();
  const controller = new BalanceController({ visible: () => true, schedule, cancel, rpc: {
    capability: async () => { attempts += 1; if (!cold) throw new BalanceClientError("balance_unavailable", "连接不可用"); throw new BalanceClientError("session_unavailable", "稍后重试"); },
    balances: async () => emptySnapshot(),
  } });
  try {
    await controller.setSession("s", MP);
    assert.equal(controller.state.open, true);
    assert.equal(controller.state.probeError, "连接不可用", "非冷错误立即呈现可重试状态");
    assert.equal(controller.state.loading, false);
    // 转为持续冷错误并手动重试：退避序列内保持加载骨架，耗尽后结束加载
    cold = true;
    await controller.retry();
    assert.equal(controller.state.loading, true, "退避期间保持加载骨架");
    for (const delay of COLD_RETRIES) {
      assert.equal(lastLive()?.ms, delay);
      await fire(lastLive()!);
      if (delay !== COLD_RETRIES.at(-1)) assert.equal(controller.state.probeError, undefined, "退避未耗尽时不应呈现错误");
    }
    assert.equal(attempts, 7, "首次非冷失败加重试后五次冷失败");
    assert.ok(controller.state.probeError, "退避耗尽后应呈现可重试状态");
    assert.equal(controller.state.loading, false, "退避耗尽后应结束加载");
    assert.equal(controller.state.open, true, "探测失败不得关闭抽屉");
  } finally { controller.dispose(); }
});

test("探测未完成前手动关闭，迟到的成功结果不得重开或读取余额", async () => {
  let releaseCap!: (value: boolean | PromiseLike<boolean>) => void;
  let balances = 0;
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => new Promise<boolean>((resolve) => { releaseCap = resolve; }),
    balances: async () => { balances += 1; return emptySnapshot(); },
  } });
  try {
    const entering = controller.setSession("s", MP);
    assert.equal(controller.state.open, true, "桌面默认展开");
    await controller.toggle(false);
    assert.equal(controller.state.open, false);
    releaseCap(true);
    await entering;
    await flush();
    assert.equal(controller.state.capability, "candidate");
    assert.equal(controller.state.open, false, "迟到的探测成功不得重开抽屉");
    assert.equal(balances, 0, "关闭状态不得读取余额");
  } finally { controller.dispose(); }
});

test("切换 MoneyPal 会话后迟到的旧会话余额不得写入新会话", async () => {
  let release!: (value: BalanceSnapshot | PromiseLike<BalanceSnapshot>) => void;
  const oldSnapshot = { asOf: "2026-08-27", assets: { accounts: [{ account: "Assets:C-旧会话", amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const newSnapshot = { asOf: "2026-08-28", assets: { accounts: [{ account: "Assets:C-新会话", amounts: [{ commodity: "CNY", quantity: "2.00" }] }], totals: [] }, liabilities: { accounts: [], totals: [] } };
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => true,
    balances: async (id) => id === "old" ? new Promise<BalanceSnapshot>((resolve) => { release = resolve; }) : newSnapshot,
  } });
  try {
    await controller.setSession("old", MP);
    assert.equal(controller.state.open, true);
    const pending = controller.setSession("new", MP);
    release(oldSnapshot);
    await pending;
    await flush();
    assert.equal(controller.state.sessionId, "new");
    assert.equal(controller.state.snapshot?.asOf, "2026-08-28", "应展示新会话快照");
    assert.equal(JSON.stringify(controller.state.snapshot).includes("旧会话"), false, "迟到的旧会话结果不得进入状态");
  } finally { controller.dispose(); }
});

test("切到非 MoneyPal 会话后取消请求、清空快照与定时器", async () => {
  let release!: (value: BalanceSnapshot | PromiseLike<BalanceSnapshot>) => void;
  const { schedule, cancel, lastLive, fire } = timerSpy();
  const controller = new BalanceController({ visible: () => true, schedule, cancel, rpc: {
    capability: async () => true,
    balances: async () => new Promise<BalanceSnapshot>((resolve) => { release = resolve; }),
  } });
  try {
    await controller.setSession("a", MP);
    assert.ok(controller.state.open);
    const pollTimer = lastLive();
    assert.ok(pollTimer, "探测轮询定时器应存在");
    const switching = controller.setSession("a");
    assert.equal(controller.state.open, false);
    assert.equal(controller.state.snapshot, undefined);
    assert.equal(controller.state.loading, false);
    assert.equal(controller.state.probeError, undefined);
    // 轮询定时器已取消：触发不应再探测；迟到的余额响应同样不得写回
    await fire(pollTimer!);
    release(cashSnapshot());
    await switching;
    await flush();
    assert.equal(controller.state.snapshot, undefined);
    assert.equal(lastLive(), undefined, "非 MoneyPal 状态不应残留定时器");
  } finally { controller.dispose(); }
});

test("桌面手动关闭后切换会话并重建控制器，偏好保持关闭", async () => {
  const first = recordingStorage();
  let balances = 0;
  const makeRpc = () => ({
    capability: async () => true,
    balances: async () => { balances += 1; return emptySnapshot(); },
  });
  const controller = new BalanceController({ visible: () => true, storage: first.storage, rpc: makeRpc() });
  let fetchedBeforeClose = 0;
  try {
    await controller.setSession("a", MP);
    assert.equal(controller.state.open, true);
    await controller.toggle(false);
    assert.deepEqual(first.written, [[OPEN_KEY, "false"]]);
    fetchedBeforeClose = balances;
    const switching = controller.setSession("b", MP);
    assert.equal(controller.state.open, false, "偏好关闭时切换会话不得展开");
    await switching;
    assert.equal(controller.state.open, false);
    assert.equal(balances, fetchedBeforeClose, "关闭偏好下不新增余额读取");
  } finally { controller.dispose(); }
  const reborn = new BalanceController({ visible: () => true, storage: first.storage, rpc: makeRpc() });
  try {
    const entering = reborn.setSession("a", MP);
    assert.equal(reborn.state.open, false, "重建控制器后仍读取到关闭偏好");
    await entering;
    assert.equal(reborn.state.open, false);
    assert.equal(balances, fetchedBeforeClose, "重建后关闭偏好仍不读取余额");
  } finally { reborn.dispose(); }
});

test("手机手动开关不改写偏好，跨断点按固定规则恢复", async () => {
  const record = recordingStorage();
  const snapshot = cashSnapshot();
  let balances = 0;
  const controller = new BalanceController({ visible: () => true, storage: record.storage, rpc: {
    capability: async () => true,
    balances: async () => { balances += 1; return snapshot; },
  } });
  try {
    // 手机进入：不展开但探测照常
    await controller.setSession("s", MP, true);
    assert.equal(controller.state.open, false);
    assert.equal(controller.state.capability, "candidate", "关闭状态仍可探测");
    await controller.toggle(true);
    assert.equal(controller.state.open, true, "手机可手动打开");
    assert.deepEqual(record.written, [], "手机开关不写存储");
    await flush();
    assert.ok(controller.state.snapshot, "手动打开后应读取余额");
    await controller.toggle(false);
    assert.equal(controller.state.open, false);
    assert.deepEqual(record.written, [], "手机关闭同样不写存储");
    // 切回桌面：偏好从未被手机操作改写，仍按默认展开
    await controller.setSession("s", MP, false);
    assert.equal(controller.state.open, true);
    await flush();
    // 再切手机：收起并保留快照，偏好不变
    await controller.setSession("s", MP, true);
    assert.equal(controller.state.open, false);
    assert.ok(controller.state.snapshot);
    assert.deepEqual(record.written, []);
  } finally { controller.dispose(); }
});

test("存储读写抛错时流程正常，桌面手动选择在当前控制器生命周期内有效", async () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const controller = new BalanceController({ visible: () => true, storage: broken, rpc: {
    capability: async () => true,
    balances: async () => emptySnapshot(),
  } });
  try {
    await controller.setSession("a", MP);
    assert.equal(controller.state.open, true, "读取抛错视为无偏好，桌面默认展开");
    await controller.toggle(false);
    assert.equal(controller.state.open, false, "写入抛错不阻断手动关闭");
    await controller.setSession("b", MP);
    assert.equal(controller.state.open, false, "内存偏好关闭，切换会话不展开");
    await controller.setSession("a", MP);
    assert.equal(controller.state.open, false, "同一控制器生命周期内偏好仍为关闭");
  } finally { controller.dispose(); }
});

test("相同上下文不重复探测，屏幕变化不当作新会话", async () => {
  let probes = 0;
  const { schedule, cancel } = timerSpy();
  const snapshot = cashSnapshot();
  const controller = new BalanceController({ visible: () => true, schedule, cancel, rpc: {
    capability: async () => { probes += 1; return true; },
    balances: async () => snapshot,
  } });
  try {
    await controller.setSession("s", MP);
    await flush();
    assert.equal(probes, 1);
    assert.ok(controller.state.snapshot);
    const before = controller.state.snapshot;
    await controller.setSession("s", MP);
    assert.equal(probes, 1, "相同上下文重复传入不得重复探测");
    await controller.setSession("s", MP, true);
    assert.equal(probes, 1, "屏幕切换不重新探测");
    assert.equal(controller.state.sessionId, "s");
    await controller.setSession("s", MP, false);
    await flush();
    assert.equal(probes, 1);
    assert.equal(controller.state.snapshot, before, "屏幕往返不清空同一会话快照");
  } finally { controller.dispose(); }
});

test("页面恢复先探测后按需刷新，不并行发起两次余额读取", async () => {
  let balances = 0;
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => true,
    balances: async () => { balances += 1; return emptySnapshot(); },
  } });
  try {
    await controller.setSession("s", MP);
    await flush();
    assert.equal(balances, 1);
    controller.visibleChanged();
    await flush(); await flush();
    assert.equal(balances, 2, "恢复后只应发起一次余额读取");
    assert.equal(controller.state.stale, false);
  } finally { controller.dispose(); }
});

test("卸载后迟到结果与定时器不再驱动状态", async () => {
  let releaseCap!: (value: boolean | PromiseLike<boolean>) => void;
  let releaseBal!: (value: BalanceSnapshot | PromiseLike<BalanceSnapshot>) => void;
  let balances = 0;
  let updates = 0;
  const { schedule, cancel, lastLive, fire } = timerSpy();
  const controller = new BalanceController({ visible: () => true, schedule, cancel, rpc: {
    capability: async () => new Promise<boolean>((resolve) => { releaseCap = resolve; }),
    balances: async () => new Promise<BalanceSnapshot>((resolve) => { releaseBal = resolve; balances += 1; }),
  } });
  controller.subscribe(() => { updates += 1; });
  try {
    void controller.setSession("s", MP);
    await flush();
    releaseCap(true);
    await flush();
    assert.ok(controller.state.open, "桌面默认展开");
    assert.equal(balances, 1, "余额请求已发出");
    const pollTimer = lastLive();
    assert.ok(pollTimer, "探测轮询定时器已建立");
    controller.dispose();
    const frozen = controller.state;
    const updatesAtDispose = updates;
    releaseCap(true);
    releaseBal(emptySnapshot());
    await fire(pollTimer!);
    await flush(); await flush();
    assert.equal(controller.state, frozen, "卸载后状态不得再变化");
    assert.equal(updates, updatesAtDispose, "卸载后不得再有状态更新");
    assert.equal(balances, 1, "卸载后不得发起新的余额请求");
  } finally { controller.dispose(); }
});

test("重开抽屉与页面恢复时旧快照标记待更新，刷新成功后解除", async () => {
  let fail = false;
  const snapshot = cashSnapshot();
  const controller = new BalanceController({ visible: () => true, storage: readonlyStorage("false"), rpc: {
    capability: async () => true,
    balances: async () => { if (fail) throw new Error("transport"); return snapshot; },
  } });
  try {
    await controller.setSession("s", MP);
    assert.equal(controller.state.open, false);
    await controller.toggle(true);
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
    await flush(); await flush();
    assert.equal(controller.state.stale, false);
  } finally { controller.dispose(); }
});

test("能力探测失败立即呈现可重试状态，重试成功后恢复", async () => {
  let fail = true;
  const controller = new BalanceController({ visible: () => true, storage: readonlyStorage("false"), rpc: {
    capability: async () => { if (fail) throw new BalanceClientError("balance_unavailable", "连接不可用"); return true; },
    balances: async () => emptySnapshot(),
  } });
  try {
    await controller.setSession("s", MP);
    assert.equal(controller.state.capability, "unknown");
    assert.equal(controller.state.probeError, "连接不可用", "探测失败未呈现可重试状态");
    assert.equal(controller.state.loading, false, "探测失败后不得停留在加载状态");
    fail = false;
    await controller.retry();
    assert.equal(controller.state.capability, "candidate");
    assert.equal(controller.state.probeError, undefined);
  } finally { controller.dispose(); }
});

test("会话能力缓存：切回已确认会话立即恢复能力并后台复探", async () => {
  let probes = 0;
  const controller = new BalanceController({ visible: () => true, rpc: {
    capability: async () => { probes += 1; return true; },
    balances: async () => cashSnapshot(),
  } });
  try {
    await controller.setSession("a", MP);
    await controller.setSession("b", MP);
    const switching = controller.setSession("a", MP);
    assert.equal(controller.state.capability, "candidate", "切回已确认会话应立即恢复缓存能力");
    await switching;
    assert.equal(controller.state.capability, "candidate");
    assert.equal(probes, 3, "恢复缓存后仍应后台复探确认");
  } finally { controller.dispose(); }
});

test("会话能力缓存：缓存陈旧时由复探纠正为普通并清空快照，抽屉保持打开", async () => {
  let ledgerExists = true;
  const snapshot = cashSnapshot();
  const controller = new BalanceController({ visible: () => true, storage: readonlyStorage("true"), rpc: {
    capability: async (id) => id === "ledger" ? ledgerExists : true,
    balances: async () => snapshot,
  } });
  try {
    await controller.setSession("ledger", MP);
    assert.ok(controller.state.snapshot);
    ledgerExists = false;
    await controller.setSession("other", MP);
    const switching = controller.setSession("ledger", MP);
    assert.equal(controller.state.capability, "candidate", "恢复时先呈现缓存能力");
    await switching;
    assert.equal(controller.state.capability, "ordinary", "复探应纠正陈旧缓存");
    assert.equal(controller.state.snapshot, undefined, "纠正后应清空旧快照");
    assert.equal(controller.state.open, true, "降级不清空展开状态");
  } finally { controller.dispose(); }
});
