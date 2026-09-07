import type { BalanceSnapshot } from "./balance.js";

export type Capability = "unknown" | "candidate" | "ordinary";
export interface BalanceRpc { capability(sessionId: string, signal: AbortSignal): Promise<boolean>; balances(sessionId: string, asOf: string, signal: AbortSignal): Promise<BalanceSnapshot>; }
export interface BalanceControllerState { sessionId?: string; capability: Capability; open: boolean; snapshot?: BalanceSnapshot; refreshedAt?: number; stale: boolean; loading: boolean; error?: string; probeError?: string; }
export interface BalanceControllerOptions { rpc: BalanceRpc; now?: () => Date; visible?: () => boolean; schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; cancel?: (timer: ReturnType<typeof setTimeout>) => void; storage?: Pick<Storage, "getItem" | "setItem">; }

export class BalanceClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BalanceClientError"; }
}

const OPEN_KEY = "dsh-moneypal.balance-open";
const POLL_MS = 30_000;
const COLD_RETRIES = [250, 500, 1_000];

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
  #rpc: BalanceRpc; #now: () => Date; #visible: () => boolean; #schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; #cancel: (timer: ReturnType<typeof setTimeout>) => void; #storage?: Pick<Storage, "getItem" | "setItem">;

  constructor(options: BalanceControllerOptions) {
    this.#rpc = options.rpc; this.#now = options.now ?? (() => new Date()); this.#visible = options.visible ?? (() => document.visibilityState === "visible"); this.#schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms)); this.#cancel = options.cancel ?? ((timer) => clearTimeout(timer)); this.#storage = options.storage;
  }
  get state(): BalanceControllerState { return this.#state; }
  subscribe(listener: (state: BalanceControllerState) => void): () => void { this.#listeners.add(listener); listener(this.#state); return () => this.#listeners.delete(listener); }

  async setSession(sessionId?: string): Promise<void> {
    if (sessionId === this.#state.sessionId) return;
    this.#cancelAll(); this.#coldAttempt = 0;
    const open = this.#state.open;
    this.#state = { sessionId, capability: sessionId ? "unknown" : "ordinary", open: sessionId ? open : false, stale: false, loading: Boolean(sessionId && open) };
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
      const open = candidate && (this.#state.open || this.#readOpen());
      this.#state = candidate
        ? { ...this.#state, capability: "candidate", open, probeError: undefined, loading: open }
        : { ...this.#state, capability: "ordinary", open: false, snapshot: undefined, refreshedAt: undefined, error: undefined, probeError: undefined, stale: false, loading: false };
      this.emit();
      if (open) void this.refresh();
      this.#scheduleProbe(POLL_MS);
    } catch (error) {
      if (!this.#currentProbe(sessionId, request)) return;
      const cold = error instanceof BalanceClientError && error.code === "session_unavailable";
      // 冷会话快速退避期间保持加载骨架；退避耗尽或非冷错误立即呈现可重试状态，不得无限显示“正在读取”。
      const backing = cold && this.#coldAttempt < COLD_RETRIES.length;
      this.#state = { ...this.#state, capability: "unknown", loading: false, stale: Boolean(this.#state.snapshot), probeError: backing ? undefined : safeMessage(error) };
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
    if (this.#state.capability !== "candidate") return;
    // 重开抽屉时旧快照明确标记待更新：关闭期间账本可能已变化，刷新成功前不得当作新鲜数据。
    this.#state = { ...this.#state, open, stale: open && Boolean(this.#state.snapshot), loading: open && !this.#state.snapshot }; this.emit();
    this.#writeOpen(open);
    if (open) await this.refresh(); else { this.#abortBalance(); this.#cancelRefresh(); }
  }

  /** 能力探测失败后的手动重试：清退避计数与可重试状态，重新探测；探测成功且抽屉打开时自动补拉余额。 */
  async retry(): Promise<void> {
    if (this.#disposed || !this.#state.sessionId) return;
    this.#coldAttempt = 0;
    this.#state = { ...this.#state, probeError: undefined, error: undefined }; this.emit();
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

/** 拆分数值与币种，供界面分别排版；字符串保持账本精度，不经过浮点数。 */
export function formatAmountParts(amount: { commodity: string; quantity: string }, negate = false): FormattedAmount {
  const [integerPart, fraction = ""] = amount.quantity.replace(/^-?/u, "").split(".");
  const negative = amount.quantity.startsWith("-") !== negate;
  const integer = integerPart.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return { value: `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`, currency: amount.commodity, negative };
}

export function formatAmount(amount: { commodity: string; quantity: string }, negate = false): string {
  const parts = formatAmountParts(amount, negate);
  return `${parts.value} ${parts.currency}`;
}
