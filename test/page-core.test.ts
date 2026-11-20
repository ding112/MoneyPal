import assert from "node:assert/strict";
import { test } from "node:test";

import type { BalanceSnapshot } from "../src/balance.js";
// 候选类型以 ledger-registry 为单一来源（client.ts 只作 type-only 引用）。
import type { LedgerCandidate } from "../src/ledger-registry.js";

import { AccountsController, BalanceClientError, pageBodyView, pageFooterStatus, rpcAccessDenied, type AccountsControllerState } from "../src/client.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const candidate = (workspaceId: string, status: LedgerCandidate["status"] = "candidate", title = workspaceId, directoryHint?: string): LedgerCandidate =>
  ({ workspaceId, title, status, ...(directoryHint ? { directoryHint } : {}) });

const snapshotFor = (account: string): BalanceSnapshot => ({ asOf: "2026-08-27", assets: { accounts: [{ account, amounts: [{ commodity: "CNY", quantity: "1.00" }] }], totals: [{ commodity: "CNY", quantity: "1.00" }] }, liabilities: { accounts: [], totals: [] } });

/** 可控时钟：固定为本地时区日期，验证余额请求携带浏览器当地日期。 */
const fixedNow = () => new Date(2026, 7, 27, 10, 0, 0);

/** 可控存储夹具：Map 后备，暴露 data 供断言「浏览器只保存手动选择的工作区 ID」。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

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
  storage?: Pick<Storage, "getItem" | "setItem">;
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
  const controller = new AccountsController({ rpc, now: () => new Date(currentTime), visible: () => visibleNow, schedule, cancel, storage: options.storage });
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

test("手动选择记住工作区 ID，自动选择不写入存储", async () => {
  const storage = memoryStorage();
  const auto = makeController({ candidates: [candidate("w1")], storage });
  try {
    await auto.controller.activate();
    await flush();
    assert.equal(auto.state().selection, "w1");
    assert.equal(auto.state().autoSelected, true);
    assert.equal(storage.data.size, 0, "自动选择只用于本次页面运行，不得写入存储");
  } finally { auto.controller.dispose(); }
  const manual = makeController({ candidates: [candidate("a"), candidate("b")], storage });
  try {
    await manual.controller.activate();
    await manual.controller.select("b");
    assert.equal(manual.state().selection, "b");
    assert.deepEqual([...storage.data.values()], ["b"], "手动选择应持久化工作区 ID，且不保存候选名之外的信息");
    await manual.controller.select("a");
    assert.deepEqual([...storage.data.values()], ["a"], "再次手动选择应覆盖上次记忆");
  } finally { manual.controller.dispose(); }
});

test("重载后恢复仍可用的手动选择并按其查询余额", async () => {
  const storage = memoryStorage();
  const first = makeController({ candidates: [candidate("a", "candidate", "家庭账本"), candidate("b", "candidate", "副业账本")], storage });
  try {
    await first.controller.activate();
    await first.controller.select("b");
    const firstB = first.pending("b");
    firstB.release(snapshotFor("Assets:副业-现金"));
    await flush();
  } finally { first.controller.dispose(); }
  // 模拟浏览器重载：全新控制器实例读取同一份存储。
  const second = makeController({ candidates: [candidate("a", "candidate", "家庭账本"), candidate("b", "candidate", "副业账本")], storage });
  try {
    await second.controller.activate();
    await flush();
    assert.equal(second.state().selection, "b", "重载后应恢复上次手动选择");
    assert.equal(second.state().selectionTitle, "副业账本");
    assert.equal(second.state().autoSelected, false, "恢复的手动选择不等同于自动选择");
    const request = second.pending("b");
    assert.equal(request.signal.aborted, false, "恢复后应立即按恢复的选择查询余额");
    request.release(snapshotFor("Assets:副业-现金"));
    await flush();
    assert.equal(second.state().snapshot?.assets.accounts[0]?.account, "Assets:副业-现金");
  } finally { second.controller.dispose(); }
});

test("无法恢复上次手动选择时等待用户重新选择，其余候选不自动选", async () => {
  const storage = memoryStorage();
  const first = makeController({ candidates: [candidate("gone"), candidate("keep")], storage });
  try {
    await first.controller.activate();
    await first.controller.select("gone");
  } finally { first.controller.dispose(); }
  // 重载后该工作区已不在候选中：即使只剩唯一其他候选也不自动选。
  const reloaded = makeController({ candidates: [candidate("keep")], storage });
  try {
    await reloaded.controller.activate();
    await flush();
    assert.equal(reloaded.state().selection, undefined, "无法恢复时等待用户重新选择");
    assert.equal(reloaded.balanceCalls(), 0, "未重新选择前不得查询余额");
    // 恢复失败与撤销清空行为一致：再次激活（含重验）仍等待用户，不得自动选中唯一候选。
    await reloaded.controller.activate();
    await flush();
    assert.equal(reloaded.state().selection, undefined, "恢复失败后的再次激活仍等待用户重新选择");
    assert.equal(reloaded.balanceCalls(), 0);
    await reloaded.controller.select("keep");
    reloaded.pending("keep").release(snapshotFor("Assets:K-现金"));
    await flush();
    assert.equal(reloaded.state().selection, "keep", "用户重新选择后恢复查询");
    assert.ok(reloaded.state().snapshot);
  } finally { reloaded.controller.dispose(); }
  // 候选仍在但暂时不可访问：同样不可恢复，等待用户。
  const second = makeController({ candidates: [candidate("gone"), candidate("keep")], storage });
  try {
    await second.controller.activate();
    await second.controller.select("gone");
  } finally { second.controller.dispose(); }
  const third = makeController({ candidates: [candidate("gone", "unavailable"), candidate("keep")], storage });
  try {
    await third.controller.activate();
    await flush();
    assert.equal(third.state().selection, undefined, "候选仍在但不可用时不得恢复");
    assert.equal(third.balanceCalls(), 0);
    assert.deepEqual(third.state().candidates?.map((item) => item.workspaceId), ["gone", "keep"], "不可用候选仍呈现给用户");
  } finally { third.controller.dispose(); }
});

test("存储读写失败时当次会话仍可选择和查询", async () => {
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  const auto = makeController({ candidates: [candidate("w1")], storage: broken });
  try {
    await auto.controller.activate();
    await flush();
    assert.equal(auto.state().selection, "w1", "读存储失败不影响候选规则与自动选择");
    auto.pending("w1").release(snapshotFor("Assets:C-现金"));
    await flush();
    assert.ok(auto.state().snapshot, "读存储失败不影响余额查询");
  } finally { auto.controller.dispose(); }
  const manual = makeController({ candidates: [candidate("a"), candidate("b")], storage: broken });
  try {
    await manual.controller.activate();
    await manual.controller.select("b");
    assert.equal(manual.state().selection, "b", "写存储失败不影响手动切换");
    manual.pending("b").release(snapshotFor("Assets:副业-现金"));
    await flush();
    assert.ok(manual.state().snapshot);
    assert.equal(manual.state().error, undefined);
  } finally { manual.controller.dispose(); }
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

test("混合四类状态时只有 candidate 计入自动选择", async () => {
  const harness = makeController({ candidates: [
    candidate("u1", "uninitialized", "新工作区"),
    candidate("i1", "invalid_layout", "旧目录", "shared/old"),
    candidate("g1", "unavailable", "离线账本"),
    candidate("w1", "candidate", "家庭账本", "home/ledger"),
  ] });
  try {
    await harness.controller.activate();
    assert.deepEqual(harness.state().candidates?.map((item) => item.workspaceId), ["u1", "i1", "g1", "w1"]);
    assert.equal(harness.state().selection, "w1", "uninitialized/invalid_layout/unavailable 登记项不得触发自动选择");
    assert.equal(harness.state().autoSelected, true);
    assert.equal(harness.state().selectionTitle, "家庭账本");
    assert.equal(harness.balanceCalls(), 1, "只应查询被选中的 candidate");
    assert.equal(harness.pending("w1").signal.aborted, false);
  } finally { harness.controller.dispose(); }
});

test("非候选登记项不触发选择，完成初始化后手动重试即重新预检并自动选中", async () => {
  let initialized = false;
  let candidateCalls = 0;
  const harness = makeController({
    candidates: async () => { candidateCalls += 1; return { candidates: [candidate("u1", initialized ? "candidate" : "uninitialized", "新工作区")] }; },
  });
  try {
    await harness.controller.activate();
    assert.equal(harness.state().selection, undefined, "未初始化的登记项不得被自动选中");
    assert.equal(harness.state().candidates?.[0]?.status, "uninitialized");
    assert.equal(harness.balanceCalls(), 0);
    // 手动重试（尚未完成初始化）：重新预检，仍不选择、不查询
    await harness.controller.retry();
    assert.equal(candidateCalls, 2, "手动重试应重新预检候选");
    assert.equal(harness.state().selection, undefined);
    assert.equal(harness.balanceCalls(), 0);
    // 在目标工作区完成初始化后手动重试：符合条件即自动选中并查询余额
    initialized = true;
    await harness.controller.retry();
    assert.equal(harness.state().selection, "u1");
    assert.equal(harness.state().autoSelected, true);
    const request = harness.pending("u1");
    request.release(snapshotFor("Assets:C-现金"));
    await flush();
    assert.ok(harness.state().snapshot);
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

test("目录暂时离线（workspace_unavailable）保持选择并标记过期，恢复后重试只更新当前账本", async () => {
  const queried: string[] = [];
  let fail = false;
  const harness = makeController({
    balances: async (workspaceId) => {
      queried.push(workspaceId);
      if (fail) throw new BalanceClientError("workspace_unavailable", "账本工作区暂时无法访问，请稍后重试。");
      return snapshotFor("Assets:C-现金");
    },
  });
  try {
    await harness.controller.activate();
    await flush();
    assert.ok(harness.state().snapshot);
    assert.notEqual(harness.state().refreshedAt, undefined);
    fail = true;
    await harness.controller.refresh();
    assert.equal(harness.state().selection, "w1", "已登记账本暂时无法读取时保持选择");
    assert.equal(harness.state().selectionTitle, "w1", "页面上账本名保持可见（默认夹具以工作区 ID 为显示名）");
    assert.equal(harness.state().snapshot?.assets.accounts[0]?.account, "Assets:C-现金", "同一账本的成功快照保留");
    assert.equal(harness.state().stale, true, "标为过期");
    assert.notEqual(harness.state().refreshedAt, undefined, "上次成功刷新时间保留");
    assert.equal(harness.state().error, "账本工作区暂时无法访问，请稍后重试。");
    assert.equal(harness.state().loading, false);
    fail = false;
    await harness.controller.refresh();
    assert.equal(harness.state().stale, false, "重试成功后清除过期状态");
    assert.equal(harness.state().error, undefined);
    assert.ok(harness.state().snapshot);
    assert.notEqual(harness.state().refreshedAt, undefined, "成功刷新时间更新");
    assert.ok(queried.length >= 2 && queried.every((id) => id === "w1"), "只更新当前所选账本的余额");
  } finally { harness.controller.dispose(); }
});

test("完整布局校验失败保留可重试的布局错误，不清空选择", async () => {
  let fail = true;
  const harness = makeController({
    balances: async () => { if (fail) throw new BalanceClientError("invalid_ledger_layout", "账本布局不符合 MoneyPal 的 Beancount 约束；请修复后重试。"); return snapshotFor("Assets:C-现金"); },
  });
  try {
    await harness.controller.activate();
    await flush();
    assert.equal(harness.state().selection, "w1", "布局错误不得像登记删除一样清空选择");
    assert.equal(harness.state().snapshot, undefined);
    assert.equal(harness.state().error, "账本布局不符合 MoneyPal 的 Beancount 约束；请修复后重试。");
    assert.equal(harness.state().loading, false);
    // 修复目录后重试：重新校验并恢复余额
    fail = false;
    await harness.controller.retry();
    await flush();
    assert.equal(harness.state().error, undefined);
    assert.ok(harness.state().snapshot);
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

test("宿主明确拒绝访问时与登记删除同样清空并等待用户重新选择", async () => {
  let candidateRounds = 0;
  let balanceCalls = 0;
  const harness = makeController({
    candidates: async () => { candidateRounds += 1; return { candidates: [candidate(candidateRounds === 1 ? "w1" : "w2")] }; },
    balances: async () => { balanceCalls += 1; if (balanceCalls === 1) throw new BalanceClientError("workspace_access_denied", "宿主拒绝了本次访问，请稍后重试。"); return snapshotFor("Assets:C-现金"); },
  });
  try {
    await harness.controller.activate();
    await flush(); await flush();
    assert.equal(harness.state().selection, undefined, "访问被拒绝后应清空选择");
    assert.equal(harness.state().snapshot, undefined, "访问被拒绝后应清空旧余额");
    assert.equal(harness.state().error, undefined, "撤销错误不作为页面主状态呈现");
    assert.equal(harness.state().candidates?.[0]?.workspaceId, "w2", "应重取候选并显示选择器");
    assert.equal(balanceCalls, 1);
    await harness.controller.activate();
    assert.equal(balanceCalls, 1, "其余候选即使只剩一个也等待用户重新选择");
    await harness.controller.select("w2");
    await flush();
    assert.equal(harness.state().selection, "w2", "用户手动选择后恢复查询");
    assert.ok(harness.state().snapshot);
  } finally { harness.controller.dispose(); }
});

test("候选重验发现所选账本预检降级时保持选择，可手动切换到其他候选", async () => {
  let candidateRounds = 0;
  const queried: string[] = [];
  const harness = makeController({
    candidates: async () => {
      candidateRounds += 1;
      return { candidates: candidateRounds === 1
        ? [candidate("w1", "candidate", "家庭账本")]
        : [candidate("w1", "unavailable", "家庭账本"), candidate("w2", "candidate", "副业账本")] };
    },
    balances: async (workspaceId) => { queried.push(workspaceId); return snapshotFor("Assets:C-现金"); },
  });
  try {
    await harness.controller.activate();
    await flush();
    assert.equal(harness.state().selection, "w1");
    assert.ok(harness.state().snapshot);
    // 目录暂时离线后回到页面：预检降级为 unavailable，但登记仍在，选择保持
    await harness.controller.activate();
    await flush();
    assert.equal(harness.state().selection, "w1", "登记仍在（预检降级）时不得清空选择");
    assert.equal(harness.state().selectionTitle, "家庭账本", "页面上账本名保持可见");
    assert.ok(harness.state().snapshot, "旧快照保留");
    assert.deepEqual(queried, ["w1", "w1"], "仍按原选择刷新余额，不自动改选其他候选");
    await harness.controller.select("w2");
    await flush();
    assert.equal(harness.state().selection, "w2", "该状态可手动切换");
    assert.equal(harness.state().selectionTitle, "副业账本");
    assert.deepEqual(queried, ["w1", "w1", "w2"]);
  } finally { harness.controller.dispose(); }
});

test("登记在重验时消失即撤销：清空快照、在途迟到成功不复活、等待手动选择", async () => {
  let candidateRounds = 0;
  const harness = makeController({
    candidates: async () => {
      candidateRounds += 1;
      return { candidates: candidateRounds === 1 ? [candidate("w1", "candidate", "家庭账本")] : [candidate("w2", "candidate", "副业账本")] };
    },
  });
  try {
    await harness.controller.activate();
    const inFlight = harness.pending("w1");
    assert.equal(harness.state().selection, "w1");
    assert.equal(harness.balanceCalls(), 1);
    // 重验发现 w1 已不在登记中：立即清空快照与选择
    await harness.controller.activate();
    await flush();
    assert.equal(harness.state().selection, undefined, "登记消失后清空选择");
    assert.equal(harness.state().snapshot, undefined, "登记消失后清空快照");
    assert.deepEqual(harness.state().candidates?.map((item) => item.workspaceId), ["w2"]);
    assert.equal(harness.balanceCalls(), 1, "其余候选即使只剩一个也等待用户重新选择");
    // 登记移除之前发出的余额请求此刻才成功返回：不得复活已撤下的数据
    inFlight.release(snapshotFor("Assets:C-撤销前"));
    await flush();
    assert.equal(harness.state().snapshot, undefined, "迟到成功响应不得重新显示已撤下的数据");
    assert.equal(harness.state().selection, undefined);
    await harness.controller.select("w2");
    harness.pending("w2").release(snapshotFor("Assets:副业-现金"));
    await flush();
    assert.equal(harness.state().selection, "w2", "用户手动选择后恢复查询");
    assert.equal(harness.state().snapshot?.assets.accounts[0]?.account, "Assets:副业-现金");
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

/* ═══ 页面正文视图模型（bundle 按此渲染；键为 bundle 字典契约） ═══ */

const pageState = (overrides: Partial<AccountsControllerState> = {}): AccountsControllerState =>
  ({ candidatesLoading: false, autoSelected: false, stale: false, loading: false, ...overrides });

test("页面正文区分空余额、明细与零候选引导", () => {
  const emptySnapshot: BalanceSnapshot = { asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } };
  assert.deepEqual(pageBodyView(pageState({ selection: "w1", snapshot: emptySnapshot })), { kind: "empty" }, "查询成功但无资产负债余额应是空余额状态");
  assert.deepEqual(pageBodyView(pageState({ selection: "w1", snapshot: emptySnapshot, loading: true })), { kind: "details" }, "空账本刷新期间仍呈现明细骨架");
  assert.deepEqual(pageBodyView(pageState({ selection: "w1", snapshot: snapshotFor("Assets:C-现金") })), { kind: "details" });
  assert.deepEqual(pageBodyView(pageState({ candidates: [] })), { kind: "zero" }, "零候选是登记引导，与空余额是不同状态");
});

test("候选列表按四类状态渲染为可选或对应引导键", () => {
  const view = pageBodyView(pageState({ candidates: [
    candidate("w1", "candidate", "家庭账本", "home/ledger"),
    candidate("u1", "uninitialized", "新工作区"),
    candidate("i1", "invalid_layout", "旧目录"),
    candidate("g1", "unavailable", "离线账本"),
  ] }));
  assert.deepEqual(view, { kind: "choice", items: [
    { workspaceId: "w1", title: "家庭账本", status: "candidate", directoryHint: "home/ledger", selectable: true },
    { workspaceId: "u1", title: "新工作区", status: "uninitialized", selectable: false, statusKey: "choice.status.uninitialized", guideKey: "choice.guide.uninitialized" },
    { workspaceId: "i1", title: "旧目录", status: "invalid_layout", selectable: false, statusKey: "choice.status.invalid_layout", guideKey: "choice.guide.invalid_layout" },
    { workspaceId: "g1", title: "离线账本", status: "unavailable", selectable: false, statusKey: "choice.status.unavailable", guideKey: "choice.guide.unavailable" },
  ] }, "candidate 可选；其余状态带状态标签与引导键，目录提示原样保留");
});

test("正文判定顺序固定：选择内加载与失败优先，候选加载、失败与零候选互不混淆", () => {
  assert.deepEqual(pageBodyView(pageState({ selection: "w1", loading: true })), { kind: "loading" });
  assert.deepEqual(pageBodyView(pageState({ selection: "w1", error: "连接不可用" })), { kind: "retryable", message: "连接不可用" });
  assert.deepEqual(pageBodyView(pageState({ candidatesLoading: true })), { kind: "loading" });
  assert.deepEqual(pageBodyView(pageState({ candidatesError: "暂时无法获取工作区列表，请稍后重试。" })), { kind: "retryable", message: "暂时无法获取工作区列表，请稍后重试。" });
  assert.deepEqual(pageBodyView(pageState({ selection: "w1", error: "连接不可用", candidatesError: "暂时无法获取工作区列表，请稍后重试。" })), { kind: "retryable", message: "连接不可用" }, "选择内的失败先于候选失败呈现");
});

test("传输层错误按宿主拒绝状态码识别为访问拒绝，其余传输失败不视为拒绝", () => {
  // DSH rpc-host 对非 owner 请求的 owner 专用精确路由以 HTTP 403 短路拒绝（不带 RPC 信封）。
  // 0.2.x 宿主 asar 实证：connection.rpc.call 把非 2xx 响应抛为纯 Error（message 含 "HTTP <status>"，无结构化字段），
  // 只有 403 是宿主的显式拒绝访问；结构化 status/statusCode 字段为宿主未来版本预留，出现且为数字时优先于消息。
  assert.equal(rpcAccessDenied(new Error("transport failure for /api/dsh-moneypal/ledger-balances: HTTP 403")), true);
  assert.equal(rpcAccessDenied(new Error("transport failure for /api/dsh-moneypal/ledger-candidates: HTTP 403")), true);
  assert.equal(rpcAccessDenied(Object.assign(new Error("transport failure for /api/dsh-moneypal/ledger-balances: HTTP 401"), { status: 403 })), true, "结构化 status 命中 403 即视为拒绝");
  assert.equal(rpcAccessDenied(Object.assign(new Error("transport failure for /api/dsh-moneypal/ledger-balances: HTTP 401"), { statusCode: 401 })), false, "结构化状态同样只认 403");
  assert.equal(rpcAccessDenied(new Error("transport failure for /api/dsh-moneypal/ledger-balances: HTTP 401")), false, "未认证是可恢复状态，不等同于明确拒绝");
  assert.equal(rpcAccessDenied(new Error("transport failure for /api/dsh-moneypal/ledger-balances: HTTP 500")), false, "宿主故障走可重试路径，不清空余额");
  assert.equal(rpcAccessDenied(new Error("connection: invalid server-response envelope")), false);
  assert.equal(rpcAccessDenied(undefined), false, "非 Error 值不视为拒绝");
});

/* ═══ 页脚状态模型（bundle 渲染 footer；键为 bundle 字典契约） ═══ */

test("页脚状态自上而下首项命中：失败优先于待更新，快照、候选与零候选各成状态", () => {
  assert.deepEqual(pageFooterStatus(pageState({ error: "连接不可用", snapshot: snapshotFor("Assets:C-现金"), stale: true })), { key: "footer.refreshFailed", dot: "warning" }, "余额失败优先呈现为可重试");
  assert.deepEqual(pageFooterStatus(pageState({ candidatesError: "暂时无法获取工作区列表，请稍后重试。" })), { key: "footer.refreshFailed", dot: "warning" }, "候选失败与余额失败同为刷新失败");
  assert.deepEqual(pageFooterStatus(pageState({ selection: "w1", loading: true })), { key: "footer.waitingLedger", dot: "neutral" }, "无快照的加载是等待账本响应");
  assert.deepEqual(pageFooterStatus(pageState({ selection: "w1", loading: true, snapshot: snapshotFor("Assets:C-现金") })), { key: "footer.refreshing", dot: "neutral" }, "有快照的加载是正在刷新");
  assert.deepEqual(pageFooterStatus(pageState({ selection: "w1", stale: true, snapshot: snapshotFor("Assets:C-现金") })), { key: "footer.stale", dot: "warning" }, "旧快照待更新是警示");
  const emptySnapshot: BalanceSnapshot = { asOf: "2026-08-27", assets: { accounts: [], totals: [] }, liabilities: { accounts: [], totals: [] } };
  assert.deepEqual(pageFooterStatus(pageState({ selection: "w1", snapshot: emptySnapshot })), { key: "footer.noData", dot: "neutral" }, "空账本与有数据可区分");
  assert.deepEqual(pageFooterStatus(pageState({ selection: "w1", snapshot: snapshotFor("Assets:C-现金") })), { key: "footer.updated", dot: "success" }, "最新快照是已更新");
  assert.deepEqual(pageFooterStatus(pageState({ candidates: [candidate("w1")] })), { key: "footer.awaiting", dot: "neutral" }, "有候选待选择是等待选择账本");
  assert.deepEqual(pageFooterStatus(pageState()), { key: "footer.zero", dot: "neutral" }, "无候选时是没有可查看的账本");
});
