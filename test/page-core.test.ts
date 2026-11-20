import assert from "node:assert/strict";
import { test } from "node:test";

import type { BalanceSnapshot } from "../src/balance.js";

import { AccountsController, BalanceClientError, type AccountsControllerState, type LedgerCandidate } from "../src/client.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const candidate = (workspaceId: string, status: LedgerCandidate["status"] = "candidate", title = workspaceId, directoryHint?: string): LedgerCandidate =>
  ({ workspaceId, title, status, ...(directoryHint ? { directoryHint } : {}) });

const snapshotFor = (account: string): BalanceSnapshot => ({ asOf: "2026-08-27", assets: { accounts: [{ account, amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [{ commodity: "CNY", quantity: "1.00" }] }, liabilities: { accounts: [], totals: [] } });

/** 可控时钟：固定为本地时区日期，验证余额请求携带浏览器当地日期。 */
const fixedNow = () => new Date(2026, 7, 27, 10, 0, 0);

interface Harness {
  controller: AccountsController;
  state: () => AccountsControllerState;
  balanceCalls: () => number;
  candidateCalls: () => number;
  /** 每次余额请求携带的 asOf，按调用顺序记录。 */
  asOfCalls: () => string[];
  /** balances 走默认延迟实现时，按工作区 ID 取出未决请求的控制柄。 */
  pending: (workspaceId: string) => { release: (snapshot: BalanceSnapshot) => void; reject: (error: unknown) => void; signal: AbortSignal };
  /** 可控时钟：set 重设当前时刻；advance 推进时间并按序触发到期的轮询定时器。 */
  clock: { set: (date: Date) => void; advance: (ms: number) => Promise<void> };
  /** 当前存活的定时器数：同一时间至多一个轮询定时器。 */
  liveTimers: () => number;
  /** 切换标签可见性，配合 controller.visibleChanged() 使用。 */
  setVisible: (visible: boolean) => void;
}

function makeController(options: {
  candidates?: Array<LedgerCandidate> | (() => Promise<{ candidates: LedgerCandidate[] }>);
  balances?: (workspaceId: string, asOf: string, signal: AbortSignal) => Promise<BalanceSnapshot>;
} = {}): Harness {
  let balanceCalls = 0;
  let candidateCalls = 0;
  const pendingRequests = new Map<string, { release: (snapshot: BalanceSnapshot) => void; reject: (error: unknown) => void; signal: AbortSignal }>();
  const asOfLog: string[] = [];
  // 可控时钟与定时器夹具：轮询、跨日与恢复行为不依赖真实等待。
  let currentTime = fixedNow().getTime();
  let visibleNow = true;
  const timers = new Set<{ callback: () => void; at: number }>();
  const schedule = (callback: () => void, ms: number) => { const timer = { callback, at: currentTime + ms }; timers.add(timer); return timer as unknown as ReturnType<typeof setTimeout>; };
  const cancel = (timer: unknown) => { timers.delete(timer as { callback: () => void; at: number }); };
  const rpc = {
    candidates: async () => {
      candidateCalls += 1;
      const value = options.candidates;
      if (typeof value === "function") return value();
      return { candidates: value ?? [candidate("w1")] };
    },
    balances: async (workspaceId: string, asOf: string, signal: AbortSignal) => {
      balanceCalls += 1;
      asOfLog.push(asOf);
      if (options.balances) return options.balances(workspaceId, asOf, signal);
      return new Promise<BalanceSnapshot>((resolve, reject) => { pendingRequests.set(workspaceId, { release: resolve, reject, signal }); });
    },
  };
  const controller = new AccountsController({ rpc, now: () => new Date(currentTime), visible: () => visibleNow, schedule, cancel });
  const clock = {
    set: (date: Date) => { currentTime = date.getTime(); },
    advance: async (ms: number) => {
      currentTime += ms;
      // 轮询回调可能完成请求后再调度下一轮：循环触发直至无到期定时器。
      for (let rounds = 0; rounds < 50; rounds += 1) {
        const due = [...timers].filter((timer) => timer.at <= currentTime);
        if (!due.length) break;
        for (const timer of due) timers.delete(timer);
        for (const timer of due) timer.callback();
        await flush();
      }
    },
  };
  return {
    controller,
    state: () => controller.state,
    balanceCalls: () => balanceCalls,
    candidateCalls: () => candidateCalls,
    asOfCalls: () => asOfLog,
    pending: (workspaceId) => pendingRequests.get(workspaceId)!,
    clock,
    liveTimers: () => timers.size,
    setVisible: (visible: boolean) => { visibleNow = visible; },
  };
}

test("唯一候选自动选中并按当地日期读取余额", async () => {
  const harness = makeController({ candidates: [candidate("w1", "candidate", "家庭账本")] });
  try {
    await harness.controller.activate();
    assert.equal(harness.state().candidatesLoading, false);
    assert.deepEqual(harness.state().candidates, [candidate("w1", "candidate", "家庭账本")]);
    assert.equal(harness.state().selection, "w1", "唯一候选应自动选中");
    assert.equal(harness.state().autoSelected, true);
    assert.equal(harness.state().selectionTitle, "家庭账本");
    assert.equal(harness.balanceCalls(), 1);
    const request = harness.pending("w1");
    assert.equal(request.signal.aborted, false);
    request.release(snapshotFor("Assets:C-现金"));
    await flush();
    assert.equal(harness.state().loading, false);
    assert.equal(harness.state().snapshot?.assets.accounts[0]?.account, "Assets:C-现金");
    assert.notEqual(harness.state().refreshedAt, undefined, "应记录本次成功刷新时间");
    assert.equal(harness.state().stale, false);
    assert.equal(harness.state().error, undefined);
    assert.equal(harness.state().candidatesError, undefined);
  } finally { harness.controller.dispose(); }
});

test("余额请求按选择携带浏览器当地日期", async () => {
  let seenAsOf = "";
  const harness = makeController({ balances: async (_workspaceId, asOf) => { seenAsOf = asOf; return snapshotFor("Assets:C-现金"); } });
  try {
    await harness.controller.activate();
    await flush();
    assert.equal(seenAsOf, "2026-08-27", "asOf 应来自注入的浏览器当地时钟");
  } finally { harness.controller.dispose(); }
});

test("多候选等待用户选择，手动选择立即切换且迟到结果按选择丢弃", async () => {
  const harness = makeController({ candidates: [candidate("a"), candidate("b")] });
  try {
    await harness.controller.activate();
    assert.equal(harness.state().selection, undefined, "多候选时不得自动选择");
    assert.equal(harness.balanceCalls(), 0);
    await harness.controller.select("nonexistent");
    assert.equal(harness.state().selection, undefined, "非候选 ID 的选择应被忽略");
    // A → B → A：第一次选 A 的迟到结果不得覆盖第三次选择
    const firstSelection = harness.controller.select("a");
    assert.equal(harness.state().selection, "a");
    assert.equal(harness.state().autoSelected, false);
    const firstA = harness.pending("a");
    assert.equal(firstA.signal.aborted, false);
    const secondSelection = harness.controller.select("b");
    assert.equal(firstA.signal.aborted, true, "切换账本应立即取消旧余额请求");
    assert.equal(harness.state().snapshot, undefined, "切换账本应清空旧快照");
    const secondB = harness.pending("b");
    const thirdSelection = harness.controller.select("a");
    assert.equal(secondB.signal.aborted, true);
    const thirdA = harness.pending("a");
    firstA.release(snapshotFor("Assets:C-第一次A"));
    await flush();
    assert.equal(harness.state().snapshot, undefined, "第一次选 A 的迟到结果不得写回");
    thirdA.release(snapshotFor("Assets:C-第三次A"));
    await flush();
    assert.equal(harness.state().snapshot?.assets.accounts[0]?.account, "Assets:C-第三次A", "页面只显示本次选择的结果");
    await Promise.all([firstSelection, secondSelection, thirdSelection]);
  } finally { harness.controller.dispose(); }
});

test("零候选不发起余额查询，与查询失败可区分", async () => {
  const harness = makeController({ candidates: [] });
  try {
    await harness.controller.activate();
    assert.deepEqual(harness.state().candidates, []);
    assert.equal(harness.state().selection, undefined);
    assert.equal(harness.state().candidatesError, undefined);
    assert.equal(harness.balanceCalls(), 0);
  } finally { harness.controller.dispose(); }
});

test("候选查询失败呈现可重试状态，重试成功后恢复自动选择", async () => {
  let fail = true;
  const harness = makeController({
    candidates: async () => { if (fail) throw new BalanceClientError("workspace_registry_unavailable", "暂时无法获取工作区列表，请稍后重试。"); return { candidates: [candidate("w1")] }; },
  });
  try {
    await harness.controller.activate();
    assert.equal(harness.state().candidates, undefined, "失败不得伪造候选结果");
    assert.equal(harness.state().candidatesError, "暂时无法获取工作区列表，请稍后重试。");
    assert.equal(harness.state().candidatesLoading, false);
    assert.equal(harness.balanceCalls(), 0);
    fail = false;
    await harness.controller.retry();
    assert.equal(harness.state().candidatesError, undefined);
    assert.equal(harness.state().selection, "w1");
    const request = harness.pending("w1");
    request.release(snapshotFor("Assets:C-现金"));
    await flush();
    assert.ok(harness.state().snapshot);
  } finally { harness.controller.dispose(); }
});

test("已有选择时再次激活重取候选、标记待更新并刷新", async () => {
  const harness = makeController({});
  try {
    await harness.controller.activate();
    const first = harness.pending("w1");
    first.release(snapshotFor("Assets:C-现金"));
    await flush();
    assert.equal(harness.state().stale, false);
    assert.ok(harness.state().snapshot);
    const second = harness.controller.activate();
    await flush();
    assert.equal(harness.state().stale, true, "激活期间的刷新应先标记旧快照待更新");
    assert.equal(harness.balanceCalls(), 2);
    const secondRequest = harness.pending("w1");
    assert.equal(secondRequest.signal.aborted, false);
    secondRequest.release(snapshotFor("Assets:C-现金"));
    await flush();
    assert.equal(harness.state().stale, false);
    await second;
  } finally { harness.controller.dispose(); }
});

test("已有选择时候选查询失败不阻断余额刷新", async () => {
  let candidatesFail = false;
  const harness = makeController({
    candidates: async () => { if (candidatesFail) throw new BalanceClientError("balance_unavailable", "连接不可用"); return { candidates: [candidate("w1")] }; },
    balances: async () => snapshotFor("Assets:C-现金"),
  });
  try {
    await harness.controller.activate();
    await flush();
    assert.equal(harness.state().selection, "w1");
    assert.ok(harness.state().snapshot);
    candidatesFail = true;
    await harness.controller.activate();
    await flush();
    assert.equal(harness.state().selection, "w1", "候选失败不得清除已有选择");
    assert.equal(harness.state().candidatesError, undefined, "已有选择时候选失败不作为页面主状态呈现");
    assert.equal(harness.balanceCalls(), 2, "仍应继续刷新所选账本余额");
    assert.ok(harness.state().snapshot);
  } finally { harness.controller.dispose(); }
});

test("临时失败保留同一账本的旧余额并标记过期，重试成功后解除", async () => {
  let fail = false;
  const harness = makeController({
    balances: async () => { if (fail) throw new BalanceClientError("balance_unavailable", "连接不可用"); return snapshotFor("Assets:C-现金"); },
  });
  try {
    await harness.controller.activate();
    await flush();
    assert.ok(harness.state().snapshot);
    fail = true;
    await harness.controller.refresh();
    assert.equal(harness.state().snapshot?.assets.accounts[0]?.account, "Assets:C-现金", "临时失败不得清空旧快照");
    assert.equal(harness.state().stale, true, "旧快照应标记待更新");
    assert.equal(harness.state().error, "连接不可用");
    assert.equal(harness.state().loading, false);
    fail = false;
    await harness.controller.refresh();
    assert.equal(harness.state().stale, false);
    assert.equal(harness.state().error, undefined);
  } finally { harness.controller.dispose(); }
});

test("宿主确认登记已删除时清空快照并等待用户重新选择", async () => {
  let candidateRounds = 0;
  let balanceCalls = 0;
  const harness = makeController({
    candidates: async () => { candidateRounds += 1; return { candidates: [candidate(candidateRounds === 1 ? "w1" : "w2")] }; },
    balances: async () => { balanceCalls += 1; if (balanceCalls === 1) throw new BalanceClientError("workspace_not_registered", "该账本工作区已不在 DSH 登记中，请重新选择。"); return snapshotFor("Assets:C-现金"); },
  });
  try {
    await harness.controller.activate();
    await flush(); await flush();
    assert.equal(harness.state().selection, undefined, "登记删除后应清空选择");
    assert.equal(harness.state().snapshot, undefined, "登记删除后应清空快照");
    assert.equal(harness.state().error, undefined);
    assert.equal(harness.state().candidates?.[0]?.workspaceId, "w2", "应重取候选结果");
    assert.equal(balanceCalls, 1);
    await harness.controller.activate();
    assert.equal(balanceCalls, 1, "其余候选即使只剩一个也等待用户重新选择");
    await harness.controller.select("w2");
    await flush();
    assert.equal(harness.state().selection, "w2", "用户手动选择后恢复查询");
    assert.ok(harness.state().snapshot);
  } finally { harness.controller.dispose(); }
});

test("候选重验发现所选工作区不再可查时清空并等待用户", async () => {
  let candidateRounds = 0;
  const harness = makeController({
    candidates: async () => {
      candidateRounds += 1;
      return { candidates: candidateRounds === 1 ? [candidate("w1")] : [candidate("w1", "invalid_layout"), candidate("w2")] };
    },
    balances: async () => snapshotFor("Assets:C-现金"),
  });
  try {
    await harness.controller.activate();
    await flush();
    assert.equal(harness.state().selection, "w1");
    assert.ok(harness.state().snapshot);
    await harness.controller.activate();
    await flush();
    assert.equal(harness.state().selection, undefined, "所选工作区不再是候选时应清空选择");
    assert.equal(harness.state().snapshot, undefined, "清空选择时应清空快照");
    assert.equal(harness.balanceCalls(), 1, "等待用户选择期间不得自动选择新账本");
    await harness.controller.select("w2");
    await flush();
    assert.equal(harness.state().selection, "w2");
    assert.ok(harness.state().snapshot);
  } finally { harness.controller.dispose(); }
});

test("激活面板且标签可见时立即检查，成功后每 30 秒轮询", async () => {
  const harness = makeController({});
  try {
    await harness.controller.activate();
    assert.equal(harness.balanceCalls(), 1, "激活时应立即检查所选账本");
    const first = harness.pending("w1");
    first.release(snapshotFor("Assets:C-第一次"));
    await flush();
    assert.equal(harness.liveTimers(), 1, "成功后应调度 30 秒轮询");
    await harness.clock.advance(29_999);
    assert.equal(harness.balanceCalls(), 1, "未满 30 秒不得提前轮询");
    await harness.clock.advance(1);
    assert.equal(harness.balanceCalls(), 2, "满 30 秒应发起下一次轮询");
    harness.pending("w1").release(snapshotFor("Assets:C-第二次"));
    await flush();
    assert.equal(harness.liveTimers(), 1, "轮询完成后继续调度下一轮");
  } finally { harness.controller.dispose(); }
  assert.equal(harness.liveTimers(), 0, "卸载后不得残留轮询定时器");
});

test("跨午夜后的轮询按浏览器当地日期重新计算 asOf", async () => {
  const harness = makeController({});
  try {
    harness.clock.set(new Date(2026, 7, 27, 23, 59, 40));
    await harness.controller.activate();
    assert.deepEqual(harness.asOfCalls(), ["2026-08-27"]);
    harness.pending("w1").release(snapshotFor("Assets:C-现金"));
    await flush();
    await harness.clock.advance(30_000);
    assert.deepEqual(harness.asOfCalls(), ["2026-08-27", "2026-08-28"], "跨午夜后的刷新应包含新一天");
    harness.pending("w1").release(snapshotFor("Assets:C-次日"));
    await flush();
    assert.equal(harness.state().snapshot?.asOf, "2026-08-27", "快照保留宿主返回的截止日期，不受本地时钟影响");
  } finally { harness.controller.dispose(); }
});

test("隐藏标签停止轮询并取消在途请求，失效响应不得改变状态或重启轮询", async () => {
  const harness = makeController({});
  try {
    await harness.controller.activate();
    harness.pending("w1").release(snapshotFor("Assets:C-现金"));
    await flush();
    await harness.clock.advance(30_000);
    const inFlight = harness.pending("w1");
    assert.equal(inFlight.signal.aborted, false);
    harness.setVisible(false);
    harness.controller.visibleChanged();
    assert.equal(inFlight.signal.aborted, true, "隐藏标签应取消在途余额请求");
    assert.equal(harness.liveTimers(), 0, "隐藏标签应停止轮询");
    assert.equal(harness.state().loading, false);
    const snapshotBefore = harness.state().snapshot;
    const refreshedAtBefore = harness.state().refreshedAt;
    inFlight.release(snapshotFor("Assets:C-隐藏后"));
    await flush(); await flush();
    assert.equal(harness.state().snapshot, snapshotBefore, "失效响应不得改写快照");
    assert.equal(harness.state().refreshedAt, refreshedAtBefore);
    assert.equal(harness.balanceCalls(), 2);
    assert.equal(harness.liveTimers(), 0, "失效响应不得重启轮询");
    harness.setVisible(true);
    harness.controller.visibleChanged();
    assert.equal(harness.balanceCalls(), 3, "恢复可见应立即检查一次");
    assert.equal(harness.state().stale, true, "恢复刷新期间旧快照应标明待更新");
    harness.pending("w1").release(snapshotFor("Assets:C-恢复"));
    await flush();
    assert.equal(harness.state().stale, false);
    assert.equal(harness.liveTimers(), 1, "恢复成功后继续 30 秒轮询");
  } finally { harness.controller.dispose(); }
});

test("离开面板停止轮询并取消在途请求，返回面板时立即检查一次", async () => {
  const harness = makeController({});
  try {
    await harness.controller.activate();
    harness.pending("w1").release(snapshotFor("Assets:C-现金"));
    await flush();
    await harness.clock.advance(30_000);
    const inFlight = harness.pending("w1");
    harness.controller.deactivate();
    assert.equal(inFlight.signal.aborted, true, "离开面板应取消在途请求");
    assert.equal(harness.liveTimers(), 0, "离开面板应停止轮询");
    assert.equal(harness.state().snapshot?.assets.accounts[0]?.account, "Assets:C-现金", "同账本快照保留在页面内存");
    inFlight.release(snapshotFor("Assets:C-离开后"));
    await flush(); await flush();
    assert.equal(harness.state().snapshot?.assets.accounts[0]?.account, "Assets:C-现金", "失效响应不得改写快照");
    assert.equal(harness.liveTimers(), 0, "失效响应不得重启轮询");
    await harness.controller.refresh();
    assert.equal(harness.balanceCalls(), 2, "离开面板后不得发起新的余额请求");
    await harness.controller.activate();
    assert.equal(harness.balanceCalls(), 3, "返回面板应立即检查一次");
    assert.equal(harness.state().stale, true, "恢复刷新期间旧快照应标明待更新");
    harness.pending("w1").release(snapshotFor("Assets:C-返回"));
    await flush();
    assert.equal(harness.state().stale, false);
    assert.equal(harness.liveTimers(), 1);
  } finally { harness.controller.dispose(); }
});

test("重合的恢复通知合并为一次有效刷新", async () => {
  const harness = makeController({});
  try {
    await harness.controller.activate();
    harness.pending("w1").release(snapshotFor("Assets:C-现金"));
    await flush();
    harness.setVisible(false);
    harness.controller.visibleChanged();
    harness.setVisible(true);
    // 同一次恢复里的重合通知：两次标签恢复通知 + 面板重新激活，只允许一次有效余额刷新。
    harness.controller.visibleChanged();
    const reactivation = harness.controller.activate();
    harness.controller.visibleChanged();
    await flush();
    assert.equal(harness.balanceCalls(), 2, "重合的恢复通知应合并为一次有效余额刷新");
    assert.equal(harness.state().stale, true, "恢复刷新期间旧快照应标明待更新");
    harness.pending("w1").release(snapshotFor("Assets:C-恢复"));
    await flush();
    assert.equal(harness.state().stale, false);
    await reactivation;
    assert.equal(harness.liveTimers(), 1);
  } finally { harness.controller.dispose(); }
});

test("手动刷新与轮询重叠时只有一个有效余额请求", async () => {
  const harness = makeController({});
  try {
    await harness.controller.activate();
    harness.pending("w1").release(snapshotFor("Assets:C-现金"));
    await flush();
    const manual = harness.controller.refresh();
    assert.equal(harness.balanceCalls(), 2, "手动刷新立即发起请求");
    await harness.clock.advance(30_000);
    assert.equal(harness.balanceCalls(), 2, "轮询与在途手动刷新重叠时应合并");
    harness.pending("w1").release(snapshotFor("Assets:C-手动"));
    await flush();
    await manual;
    assert.equal(harness.state().snapshot?.assets.accounts[0]?.account, "Assets:C-手动");
    assert.equal(harness.liveTimers(), 1, "慢请求完成后恢复唯一轮询链");
    await harness.clock.advance(30_000);
    assert.equal(harness.balanceCalls(), 3, "轮询链继续");
    harness.pending("w1").release(snapshotFor("Assets:C-现金"));
    await flush();
  } finally { harness.controller.dispose(); }
});

test("轮询失败保留旧快照并继续 30 秒重试", async () => {
  let fail = false;
  const harness = makeController({
    balances: async () => { if (fail) throw new BalanceClientError("balance_unavailable", "连接不可用"); return snapshotFor("Assets:C-现金"); },
  });
  try {
    await harness.controller.activate();
    await flush();
    assert.equal(harness.state().stale, false);
    fail = true;
    await harness.clock.advance(30_000);
    await flush();
    assert.equal(harness.state().stale, true, "轮询失败应保留旧快照并标记待更新");
    assert.equal(harness.state().error, "连接不可用");
    assert.equal(harness.liveTimers(), 1, "失败后仍应继续 30 秒轮询");
    fail = false;
    await harness.clock.advance(30_000);
    await flush();
    assert.equal(harness.state().stale, false, "下一次轮询成功后解除待更新");
    assert.equal(harness.state().error, undefined);
  } finally { harness.controller.dispose(); }
});

test("隐藏打断首次候选查询时，恢复可见重新检查候选并继续查询", async () => {
  let releaseCandidates: ((value: { candidates: LedgerCandidate[] }) => void) | undefined;
  const harness = makeController({
    candidates: () => new Promise((resolve) => { releaseCandidates = resolve; }),
  });
  try {
    // 候选请求保持未决：activate 不必等待，候选请求在同步段即已发出。
    void harness.controller.activate();
    await flush();
    assert.equal(harness.candidateCalls(), 1);
    harness.setVisible(false);
    harness.controller.visibleChanged();
    assert.equal(harness.state().candidatesLoading, false, "隐藏应取消在途候选请求");
    harness.setVisible(true);
    harness.controller.visibleChanged();
    await flush();
    assert.equal(harness.candidateCalls(), 2, "恢复可见应补一次候选检查");
    releaseCandidates!({ candidates: [candidate("w1")] });
    await flush(); await flush();
    assert.equal(harness.state().selection, "w1", "候选就绪后仍按选择规则自动选中");
    assert.equal(harness.balanceCalls(), 1, "候选就绪后自动开始余额查询");
    harness.pending("w1").release(snapshotFor("Assets:C-现金"));
    await flush();
    assert.ok(harness.state().snapshot);
  } finally { harness.controller.dispose(); }
});

test("卸载后迟到结果与在途请求不再驱动状态", async () => {
  const harness = makeController({});
  let updates = 0;
  const controller = harness.controller;
  controller.subscribe(() => { updates += 1; });
  try {
    await controller.activate();
    const request = harness.pending("w1");
    assert.equal(harness.balanceCalls(), 1);
    const frozen = controller.state;
    const updatesAtDispose = updates;
    const candidateCalls = harness.candidateCalls();
    controller.dispose();
    request.release(snapshotFor("Assets:C-卸载后"));
    await flush(); await flush();
    assert.equal(controller.state, frozen, "卸载后状态不得再变化");
    assert.equal(updates, updatesAtDispose, "卸载后不得再有状态更新");
    await controller.activate();
    await controller.refresh();
    await controller.select("w1");
    await controller.retry();
    assert.equal(harness.candidateCalls(), candidateCalls, "卸载后不得发起新的候选查询");
    assert.equal(harness.balanceCalls(), 1, "卸载后不得发起新的余额请求");
  } finally { controller.dispose(); }
});
