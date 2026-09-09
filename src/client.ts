import type { BalanceAccount, BalanceSnapshot } from "./balance.js";

export type Capability = "unknown" | "candidate" | "ordinary";
export interface BalanceRpc { capability(sessionId: string, signal: AbortSignal): Promise<boolean>; balances(sessionId: string, asOf: string, signal: AbortSignal): Promise<BalanceSnapshot>; }
export interface BalanceControllerState { sessionId?: string; capability: Capability; open: boolean; snapshot?: BalanceSnapshot; refreshedAt?: number; stale: boolean; loading: boolean; error?: string; probeError?: string; }
export interface BalanceControllerOptions { rpc: BalanceRpc; now?: () => Date; visible?: () => boolean; schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; cancel?: (timer: ReturnType<typeof setTimeout>) => void; storage?: Pick<Storage, "getItem" | "setItem">; }

export class BalanceClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BalanceClientError"; }
}

const OPEN_KEY = "dsh-moneypal.balance-open";
const POLL_MS = 30_000;
// 冷会话退避序列：调度近似值，未计 RPC 耗时；耗尽窗口约 1.6s，其后仅按 30s 轮询重探。
const COLD_RETRIES = [100, 150, 250, 400, 700];

/** 所有会话、轮询、取消与持久化规则都集中在此处；React 只订阅此状态。 */
export class BalanceController {
  #state: BalanceControllerState = { capability: "unknown", open: false, stale: false, loading: false };
  #listeners = new Set<(state: BalanceControllerState) => void>();
  #probeTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #probeRequest: AbortController | undefined;
  #balanceRequest: AbortController | undefined;
  #coldAttempt = 0;
  #disposed = false;
  #capabilityCache = new Map<string, Exclude<Capability, "unknown">>();
  #rpc: BalanceRpc; #now: () => Date; #visible: () => boolean; #schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; #cancel: (timer: ReturnType<typeof setTimeout>) => void; #storage?: Pick<Storage, "getItem" | "setItem">;

  constructor(options: BalanceControllerOptions) {
    this.#rpc = options.rpc; this.#now = options.now ?? (() => new Date()); this.#visible = options.visible ?? (() => document.visibilityState === "visible"); this.#schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms)); this.#cancel = options.cancel ?? ((timer) => clearTimeout(timer)); this.#storage = options.storage;
  }
  get state(): BalanceControllerState { return this.#state; }
  subscribe(listener: (state: BalanceControllerState) => void): () => void { this.#listeners.add(listener); listener(this.#state); return () => this.#listeners.delete(listener); }

  async setSession(sessionId?: string): Promise<void> {
    if (sessionId === this.#state.sessionId) return;
    this.#cancelAll(); this.#coldAttempt = 0;
    // 已确认过的会话直接恢复缓存能力：candidate 让入口立即显示，ordinary 立即关闭抽屉；
    // 打开偏好不在此处改写，随后的后台复探确认后按既有路径补开或纠正陈旧缓存。
    const cached = sessionId ? this.#capabilityCache.get(sessionId) : undefined;
    const capability = cached ?? (sessionId ? "unknown" : "ordinary");
    const open = capability === "ordinary" ? false : this.#state.open;
    this.#state = { sessionId, capability, open, stale: false, loading: Boolean(sessionId && open) };
    this.emit();
    if (sessionId && this.#visible()) await this.probe();
  }

  async probe(): Promise<void> {
    const sessionId = this.#state.sessionId;
    if (!sessionId || this.#disposed || !this.#visible()) return;
    this.#abortProbe(); const request = new AbortController(); this.#probeRequest = request;
    try {
      const candidate = await this.#rpc.capability(sessionId, request.signal);
      if (!this.#currentProbe(sessionId, request)) return;
      this.#coldAttempt = 0;
      this.#capabilityCache.set(sessionId, candidate ? "candidate" : "ordinary");
      const open = candidate && (this.#state.open || this.#readOpen());
      this.#state = candidate
        ? { ...this.#state, capability: "candidate", open, probeError: undefined, loading: open }
        : { ...this.#state, capability: "ordinary", open: false, snapshot: undefined, refreshedAt: undefined, error: undefined, probeError: undefined, stale: false, loading: false };
      // 降级为普通时原子取消在途余额请求与刷新节奏：迟到的响应被身份校验丢弃，不得写回快照。
      if (!candidate) { this.#abortBalance(); this.#cancelRefresh(); }
      this.emit();
      if (open) void this.refresh();
      this.#scheduleProbe(POLL_MS);
    } catch (error) {
      if (!this.#currentProbe(sessionId, request)) return;
      const cold = error instanceof BalanceClientError && error.code === "session_unavailable";
      // 冷会话快速退避期间保持加载骨架（已打开的抽屉不闪错误）；退避耗尽或非冷错误立即呈现可重试状态，不得无限显示“正在读取”。
      const backing = cold && this.#coldAttempt < COLD_RETRIES.length;
      this.#state = { ...this.#state, capability: "unknown", loading: backing && this.#state.open, stale: Boolean(this.#state.snapshot), probeError: backing ? undefined : safeMessage(error) };
      this.emit();
      this.#scheduleProbe(backing ? COLD_RETRIES[this.#coldAttempt++] : POLL_MS);
    }
  }

  async refresh(): Promise<void> {
    const sessionId = this.#state.sessionId;
    if (!sessionId || this.#state.capability !== "candidate" || !this.#state.open || this.#disposed || !this.#visible()) return;
    this.#abortBalance(); const request = new AbortController(); this.#balanceRequest = request;
    this.#state = { ...this.#state, loading: true, error: undefined }; this.emit();
    try {
      const snapshot = await this.#rpc.balances(sessionId, localDate(this.#now()), request.signal);
      if (!this.#currentBalance(sessionId, request)) return;
      this.#state = { ...this.#state, snapshot, refreshedAt: this.#now().getTime(), stale: false, loading: false }; this.emit();
      this.#scheduleRefresh(POLL_MS);
    } catch (error) {
      if (!this.#currentBalance(sessionId, request)) return;
      this.#state = { ...this.#state, loading: false, stale: Boolean(this.#state.snapshot), error: safeMessage(error) }; this.emit();
      this.#scheduleRefresh(POLL_MS);
    }
  }

  async toggle(open = !this.#state.open): Promise<void> {
    if (this.#disposed) return;
    if (!open) {
      // 关闭分支先行：未知能力也允许关闭；写入关闭偏好并停止余额请求与轮询，后台能力探测保留。
      this.#state = { ...this.#state, open: false, loading: false }; this.emit();
      this.#writeOpen(false);
      this.#abortBalance(); this.#cancelRefresh();
      return;
    }
    if (this.#state.open) return;
    // 打开仅限候选会话，或探测失败后的恢复路径；冷退避与首次探测期间、普通会话不响应。
    const recoverable = this.#state.capability === "candidate" || (this.#state.capability === "unknown" && Boolean(this.#state.probeError));
    if (!recoverable) return;
    if (this.#state.capability === "unknown") {
      // 失败态恢复：只展示既有错误/过期快照并保存打开偏好；不清错误、不进加载态，余额读取等探测确认能力后进行。
      this.#state = { ...this.#state, open: true, stale: Boolean(this.#state.snapshot) }; this.emit();
      this.#writeOpen(true);
      return;
    }
    // 重开抽屉时旧快照明确标记待更新：关闭期间账本可能已变化，刷新成功前不得当作新鲜数据。
    this.#state = { ...this.#state, open: true, stale: Boolean(this.#state.snapshot), loading: !this.#state.snapshot }; this.emit();
    this.#writeOpen(true);
    await this.refresh();
  }

  /** 探测失败后的手动重试：取消既有探测节奏并清退避计数与可重试状态，重新探测；
   * 已打开的抽屉进入加载态并保留旧快照与过期标记；探测确认能力后由 probe 路径自动补拉余额。 */
  async retry(): Promise<void> {
    if (this.#disposed || !this.#state.sessionId) return;
    this.#cancelProbeTimer();
    this.#coldAttempt = 0;
    this.#state = { ...this.#state, probeError: undefined, error: undefined, loading: this.#state.open }; this.emit();
    await this.probe();
  }

  visibleChanged(): void {
    if (!this.#visible()) { this.#cancelAll(); return; }
    if (!this.#state.sessionId) return;
    // 连接/页面恢复：旧快照标记待更新后再探测与刷新，成功后原子替换。
    if (this.#state.open && this.#state.snapshot && !this.#state.stale) { this.#state = { ...this.#state, stale: true }; this.emit(); }
    void this.probe(); if (this.#state.open && this.#state.capability === "candidate") void this.refresh();
  }
  dispose(): void { this.#disposed = true; this.#cancelAll(); this.#listeners.clear(); }

  #readOpen(): boolean { try { return this.#storage?.getItem(OPEN_KEY) === "true"; } catch { return false; } }
  #writeOpen(open: boolean): void { try { this.#storage?.setItem(OPEN_KEY, String(open)); } catch { /* 开关持久化失败时降级为内存状态，不阻塞余额流程 */ } }

  #scheduleProbe(ms: number): void { this.#cancelProbeTimer(); if (!this.#disposed && this.#visible() && this.#state.sessionId) this.#probeTimer = this.#schedule(() => void this.probe(), ms); }
  #scheduleRefresh(ms: number): void { this.#cancelRefresh(); if (!this.#disposed && this.#visible() && this.#state.open && this.#state.capability === "candidate") this.#refreshTimer = this.#schedule(() => void this.refresh(), ms); }
  #cancelProbeTimer(): void { if (this.#probeTimer) this.#cancel(this.#probeTimer); this.#probeTimer = undefined; }
  #cancelRefresh(): void { if (this.#refreshTimer) this.#cancel(this.#refreshTimer); this.#refreshTimer = undefined; }
  #abortProbe(): void { this.#probeRequest?.abort(); this.#probeRequest = undefined; }
  #abortBalance(): void { this.#balanceRequest?.abort(); this.#balanceRequest = undefined; }
  #cancelAll(): void { this.#abortProbe(); this.#abortBalance(); this.#cancelProbeTimer(); this.#cancelRefresh(); }
  #currentProbe(sessionId: string, request: AbortController): boolean { return !this.#disposed && this.#state.sessionId === sessionId && this.#probeRequest === request && !request.signal.aborted; }
  #currentBalance(sessionId: string, request: AbortController): boolean { return !this.#disposed && this.#state.sessionId === sessionId && this.#balanceRequest === request && !request.signal.aborted; }
  private emit(): void { for (const listener of this.#listeners) listener(this.#state); }
}

function safeMessage(error: unknown): string { return error instanceof BalanceClientError && error.message ? error.message : "暂时无法读取账户余额，请重试。"; }

export function localDate(value: Date): string { const year = value.getFullYear(); const month = String(value.getMonth() + 1).padStart(2, "0"); const day = String(value.getDate()).padStart(2, "0"); return `${year}-${month}-${day}`; }
export interface FormattedAmount { value: string; currency: string; negative: boolean; }

const integerFormatters = new Map<string, Intl.NumberFormat>();
const decimalSeparators = new Map<string, string>();

/** 整数部分分组格式化器按 locale 缓存：分组是展示习惯，与账本数值无关。 */
function integerGrouping(locale: string): Intl.NumberFormat {
  let formatter = integerFormatters.get(locale);
  if (!formatter) { formatter = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 }); integerFormatters.set(locale, formatter); }
  return formatter;
}

/** 小数分隔符取自同 locale 的常量 1.1，不含账本数据。 */
function decimalSeparator(locale: string): string {
  let separator = decimalSeparators.get(locale);
  if (!separator) {
    separator = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".";
    decimalSeparators.set(locale, separator);
  }
  return separator;
}

/** 拆分数值与币种，供界面分别排版；字符串保持账本精度，不经过浮点数。
 * 整数部分经 BigInt 与 Intl 分组（支持任意位数），小数部分原样保留全部尾随零；locale 仅影响分组与分隔符。 */
export function formatAmountParts(amount: { commodity: string; quantity: string }, negate = false, locale = "zh-CN"): FormattedAmount {
  const [integerPart, fraction = ""] = amount.quantity.replace(/^-?/u, "").split(".");
  const negative = amount.quantity.startsWith("-") !== negate;
  const integer = integerGrouping(locale).format(BigInt(integerPart || "0"));
  return { value: `${negative ? "-" : ""}${integer}${fraction ? `${decimalSeparator(locale)}${fraction}` : ""}`, currency: amount.commodity, negative };
}

export function formatAmount(amount: { commodity: string; quantity: string }, negate = false, locale = "zh-CN"): string {
  const parts = formatAmountParts(amount, negate, locale);
  return `${parts.value} ${parts.currency}`;
}

export interface PreviewEntry { account: BalanceAccount; liability: boolean; }

export type FooterDot = "neutral" | "warning" | "success";
export interface FooterStatus { key: string; dot: FooterDot; }

/** 页脚唯一状态模型：自上而下首项命中，同时给出文案键与圆点类型；圆点仅是视觉辅助（aria-hidden），含义由文字表达。 */
export function footerStatus(state: Pick<BalanceControllerState, "error" | "probeError" | "loading" | "stale" | "snapshot">): FooterStatus {
  if (state.error || state.probeError) return { key: "status.refreshFailed", dot: "warning" };
  if (state.loading) return { key: state.snapshot ? "status.refreshing" : "status.waitingLedger", dot: "neutral" };
  if (state.stale) return { key: "status.stale", dot: "warning" };
  if (state.snapshot && !state.snapshot.assets.accounts.length && !state.snapshot.liabilities.accounts.length) return { key: "status.noData", dot: "neutral" };
  if (state.snapshot) return { key: "status.autoRefresh", dot: "success" };
  return { key: "status.waitingLedger", dot: "neutral" };
}

/** 概览预览选择：资产在前、负债在后并保留各组原顺序；全部账户恰好一个商品且每账户恰好一条金额时按绝对金额降序，其余不排序；最多三条。 */
export function selectPreviewAccounts(snapshot: BalanceSnapshot): PreviewEntry[] {
  const entries: PreviewEntry[] = [
    ...snapshot.assets.accounts.map((account) => ({ account, liability: false })),
    ...snapshot.liabilities.accounts.map((account) => ({ account, liability: true })),
  ];
  const commodities = new Set<string>();
  for (const entry of entries) for (const amount of entry.account.amounts) commodities.add(amount.commodity);
  const sortable = commodities.size === 1 && entries.every((entry) => entry.account.amounts.length === 1);
  // 稳定排序：绝对金额相等时保留原顺序；包装数组排序不触碰快照本身。
  const ordered = sortable ? [...entries].sort((left, right) => -compareAbsoluteDecimal(left.account.amounts[0]!.quantity, right.account.amounts[0]!.quantity)) : entries;
  return ordered.slice(0, 3);
}

/** 十进制字符串绝对值比较：整数去前导零后先比位数再比字典序，小数右补零到等长后比较；不经浮点数。 */
function compareAbsoluteDecimal(left: string, right: string): -1 | 0 | 1 {
  const magnitude = (value: string) => {
    const [integer, fraction = ""] = value.replace(/^-/u, "").split(".");
    return { digits: integer.replace(/^0+/u, "") || "0", fraction };
  };
  const a = magnitude(left); const b = magnitude(right);
  if (a.digits.length !== b.digits.length) return a.digits.length < b.digits.length ? -1 : 1;
  if (a.digits !== b.digits) return a.digits < b.digits ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const aFraction = a.fraction.padEnd(width, "0"); const bFraction = b.fraction.padEnd(width, "0");
  return aFraction === bFraction ? 0 : aFraction < bFraction ? -1 : 1;
}
