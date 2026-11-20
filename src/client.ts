import type { BalanceAccount, BalanceSnapshot } from "./balance.js";

export type Capability = "unknown" | "candidate" | "ordinary";
export interface BalanceRpc { capability(sessionId: string, signal: AbortSignal): Promise<boolean>; balances(sessionId: string, asOf: string, signal: AbortSignal): Promise<BalanceSnapshot>; }
export interface BalanceControllerState { sessionId?: string; presetId?: string; compact: boolean; capability: Capability; open: boolean; snapshot?: BalanceSnapshot; refreshedAt?: number; stale: boolean; loading: boolean; error?: string; probeError?: string; }
export interface BalanceControllerOptions { rpc: BalanceRpc; now?: () => Date; visible?: () => boolean; schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; cancel?: (timer: ReturnType<typeof setTimeout>) => void; storage?: Pick<Storage, "getItem" | "setItem">; }

/** 从 DSH 会话列表中找出当前主视图持有的会话。 */
export function selectMainSessionId(sessions: { byId: Record<string, { id: string; retainedBy?: { mainView?: number } }> }): string | undefined {
  return Object.values(sessions.byId).find((session) => (session.retainedBy?.mainView ?? 0) > 0)?.id;
}

/** 读取指定 DSH 会话记录的 preset 投影；未挂载或非字符串值视为未确定。 */
export function selectSessionPreset(sessions: { byId: Record<string, { projectionValues?: { agentPreset?: unknown } }> }, sessionId?: string): string | undefined {
  const preset = sessionId ? sessions.byId[sessionId]?.projectionValues?.agentPreset : undefined;
  return typeof preset === "string" ? preset : undefined;
}

export class BalanceClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BalanceClientError"; }
}

const OPEN_KEY = "dsh-moneypal.balance-open";
// 会话 preset 的匹配 ID：大小写精确匹配，不匹配展示名称或字符串片段。
const MONEYPAL_PRESET = "dsh-moneypal";
const POLL_MS = 30_000;
// 冷会话退避序列：调度近似值，未计 RPC 耗时；耗尽窗口约 1.6s，其后仅按 30s 轮询重探。
const COLD_RETRIES = [100, 150, 250, 400, 700];

/** 所有会话、轮询、取消与持久化规则都集中在此处；React 只订阅此状态。
 * 入口与抽屉的可见性只由会话 preset 决定，能力探测仅决定抽屉内的内容。 */
export class BalanceController {
  #state: BalanceControllerState = { compact: false, capability: "unknown", open: false, stale: false, loading: false };
  #listeners = new Set<(state: BalanceControllerState) => void>();
  #probeTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #probeRequest: AbortController | undefined;
  #balanceRequest: AbortController | undefined;
  #coldAttempt = 0;
  #disposed = false;
  #capabilityCache = new Map<string, Exclude<Capability, "unknown">>();
  /** 桌面打开偏好：构造时读取一次；仅桌面手动开关会改写，自动路径一律不改。 */
  #openPreference: boolean | undefined;
  #rpc: BalanceRpc; #now: () => Date; #visible: () => boolean; #schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; #cancel: (timer: ReturnType<typeof setTimeout>) => void; #storage?: Pick<Storage, "getItem" | "setItem">;

  constructor(options: BalanceControllerOptions) {
    this.#rpc = options.rpc; this.#now = options.now ?? (() => new Date()); this.#visible = options.visible ?? (() => document.visibilityState === "visible"); this.#schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms)); this.#cancel = options.cancel ?? ((timer) => clearTimeout(timer)); this.#storage = options.storage;
    this.#openPreference = this.#readOpenPreference();
  }
  get state(): BalanceControllerState { return this.#state; }
  subscribe(listener: (state: BalanceControllerState) => void): () => void { this.#listeners.add(listener); listener(this.#state); return () => this.#listeners.delete(listener); }

  async setSession(sessionId?: string, presetId?: string, compact = false): Promise<void> {
    if (this.#disposed) return;
    if (sessionId === this.#state.sessionId && presetId === this.#state.presetId && compact === this.#state.compact) return;
    if (!sessionId || presetId !== MONEYPAL_PRESET) {
      // 无会话、preset 未定或非 MoneyPal：立即关闭并清空全部会话数据，取消请求与定时器，不发起探测，不改偏好。
      this.#cancelAll(); this.#coldAttempt = 0;
      this.#state = { sessionId, presetId, compact, capability: sessionId ? "unknown" : "ordinary", open: false, snapshot: undefined, refreshedAt: undefined, stale: false, loading: false, error: undefined, probeError: undefined };
      this.emit();
      return;
    }
    if (sessionId !== this.#state.sessionId || this.#state.presetId !== presetId) {
      // 首次进入 MoneyPal 会话（含 preset 延迟确定）：取消旧请求、清空旧数据，按屏幕与偏好决定展开后探测；
      // 已确认过的会话恢复缓存能力，避免内容闪回未确定态。偏好不在此处改写。
      this.#cancelAll(); this.#coldAttempt = 0;
      const cached = this.#capabilityCache.get(sessionId);
      const capability = cached ?? "unknown";
      const open = !compact && (this.#openPreference ?? true);
      this.#state = { sessionId, presetId, compact, capability, open, stale: false, loading: open && capability !== "ordinary" };
      this.emit();
      if (this.#visible()) await this.probe();
      return;
    }
    if (compact) {
      // 桌面切到手机：收起并停止余额请求与刷新；同一会话的快照保留，偏好不变，能力探测节奏继续。
      this.#abortBalance(); this.#cancelRefresh();
      this.#state = { ...this.#state, compact, open: false, loading: false };
      this.emit();
      return;
    }
    // 手机切回桌面：按桌面偏好恢复；重新展开时旧快照标记待更新并重新获取最新数据。
    const open = this.#openPreference ?? true;
    this.#state = { ...this.#state, compact, open, stale: open ? Boolean(this.#state.snapshot) : this.#state.stale, loading: false };
    this.emit();
    if (open) await this.refresh();
  }

  async probe(): Promise<void> {
    const sessionId = this.#state.sessionId;
    if (!sessionId || this.#state.presetId !== MONEYPAL_PRESET || this.#disposed || !this.#visible()) return;
    this.#abortProbe(); const request = new AbortController(); this.#probeRequest = request;
    try {
      const candidate = await this.#rpc.capability(sessionId, request.signal);
      if (!this.#currentProbe(sessionId, request)) return;
      this.#coldAttempt = 0;
      this.#capabilityCache.set(sessionId, candidate ? "candidate" : "ordinary");
      // 探测不重新计算 open、不读取打开偏好：不能关闭抽屉，也不能把已关闭抽屉重新打开；
      // 成功后仅在抽屉已打开时读取余额。降级为普通时保持展开，原子取消在途余额请求与刷新节奏。
      const open = this.#state.open;
      this.#state = candidate
        ? { ...this.#state, capability: "candidate", probeError: undefined, loading: open }
        : { ...this.#state, capability: "ordinary", snapshot: undefined, refreshedAt: undefined, error: undefined, probeError: undefined, stale: false, loading: false };
      if (!candidate) { this.#abortBalance(); this.#cancelRefresh(); }
      this.emit();
      if (candidate && open) void this.refresh();
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
    if (!sessionId || this.#state.presetId !== MONEYPAL_PRESET || this.#state.capability !== "candidate" || !this.#state.open || this.#disposed || !this.#visible()) return;
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
    if (this.#disposed || !this.#isMoneypal()) return;
    if (!open) {
      // 手动关闭：停止余额请求与刷新，能力探测可继续；桌面先更新内存偏好再尝试写存储，写入失败不回滚。
      this.#state = { ...this.#state, open: false, loading: false }; this.emit();
      this.#rememberManual(false);
      this.#abortBalance(); this.#cancelRefresh();
      return;
    }
    if (this.#state.open) return;
    // 手动打开：显示抽屉；已确认候选 → 旧快照标记待更新并立即刷新；能力未知或无账本 → 重新探测确认。
    const hadSnapshot = Boolean(this.#state.snapshot);
    this.#state = { ...this.#state, open: true, stale: hadSnapshot, loading: this.#state.capability === "candidate" && !hadSnapshot }; this.emit();
    this.#rememberManual(true);
    if (this.#state.capability === "candidate") await this.refresh();
    else await this.retry();
  }

  /** 探测失败后的手动重试：取消既有探测节奏并清退避计数与可重试状态，重新探测；
   * 已打开的抽屉进入加载态并保留旧快照与过期标记；探测确认能力后由 probe 路径自动补拉余额。 */
  async retry(): Promise<void> {
    if (this.#disposed || !this.#isMoneypal()) return;
    this.#cancelProbeTimer();
    this.#coldAttempt = 0;
    this.#state = { ...this.#state, probeError: undefined, error: undefined, loading: this.#state.open }; this.emit();
    await this.probe();
  }

  visibleChanged(): void {
    if (!this.#visible()) { this.#cancelAll(); return; }
    if (!this.#isMoneypal()) return;
    // 页面恢复统一先探测：探测成功后由探测路径按需读取余额，不再并行直接刷新，避免重复请求。
    if (this.#state.open && this.#state.snapshot && !this.#state.stale) { this.#state = { ...this.#state, stale: true }; this.emit(); }
    void this.probe();
  }
  dispose(): void { this.#disposed = true; this.#cancelAll(); this.#listeners.clear(); }

  #isMoneypal(): boolean { return Boolean(this.#state.sessionId) && this.#state.presetId === MONEYPAL_PRESET; }

  #readOpenPreference(): boolean | undefined {
    try {
      const raw = this.#storage?.getItem(OPEN_KEY);
      return raw === "true" ? true : raw === "false" ? false : undefined;
    } catch { return undefined; }
  }
  /** 仅桌面手动开关写偏好：先记内存再尝试持久化，失败降级为内存状态，不回滚、不阻塞余额流程。 */
  #rememberManual(open: boolean): void {
    if (this.#state.compact) return;
    this.#openPreference = open;
    this.#writeOpen(open);
  }
  #writeOpen(open: boolean): void { try { this.#storage?.setItem(OPEN_KEY, String(open)); } catch { /* 开关持久化失败时降级为内存状态 */ } }

  #scheduleProbe(ms: number): void { this.#cancelProbeTimer(); if (!this.#disposed && this.#visible() && this.#isMoneypal()) this.#probeTimer = this.#schedule(() => void this.probe(), ms); }
  #scheduleRefresh(ms: number): void { this.#cancelRefresh(); if (!this.#disposed && this.#visible() && this.#isMoneypal() && this.#state.open && this.#state.capability === "candidate") this.#refreshTimer = this.#schedule(() => void this.refresh(), ms); }
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

/* ═══ 独立账户页（ADR-0006）：候选加载、选择规则与余额请求隔离 ═══ */

export type LedgerCandidateStatus = "candidate" | "uninitialized" | "invalid_layout" | "unavailable";
export interface LedgerCandidate { workspaceId: string; title: string; status: LedgerCandidateStatus; directoryHint?: string; }

/** 独立账户页的两条 RPC（宿主端见 src/host.ts 的 ledger-candidates / ledger-balances）。 */
export interface LedgerRpc {
  candidates(signal: AbortSignal): Promise<{ candidates: LedgerCandidate[] }>;
  balances(workspaceId: string, asOf: string, signal: AbortSignal): Promise<BalanceSnapshot>;
}

export interface AccountsControllerState {
  /** undefined = 尚未取得候选结果；[] = 已取得但零候选。 */
  candidates?: LedgerCandidate[];
  candidatesLoading: boolean;
  /** 候选查询失败（可重试）；已有选择时仅记录，不阻断余额查询。 */
  candidatesError?: string;
  /** 当前选中的工作区 ID；undefined 表示等待用户选择（含零候选）。 */
  selection?: string;
  selectionTitle?: string;
  /** 当前选择是否为自动选择：仅本次页面运行期有效，不持久化；手动选择（含重载恢复）为 false。 */
  autoSelected: boolean;
  snapshot?: BalanceSnapshot;
  refreshedAt?: number;
  stale: boolean;
  loading: boolean;
  error?: string;
}

export interface AccountsControllerOptions { rpc: LedgerRpc; now?: () => Date; visible?: () => boolean; storage?: Pick<Storage, "getItem" | "setItem">; }

const WORKSPACE_KEY = "dsh-moneypal.accounts-workspace";

/** 独立账户页控制器：候选加载、选择规则、余额请求隔离与刷新全部集中在此处；React 只订阅此状态。
 * 30 秒轮询、面板激活与标签可见性的刷新机制由后续票在 activate/refresh 的调用点扩展。 */
export class AccountsController {
  #state: AccountsControllerState = { candidatesLoading: false, autoSelected: false, stale: false, loading: false };
  #listeners = new Set<(state: AccountsControllerState) => void>();
  #candidatesRequest: AbortController | undefined;
  #balanceRequest: AbortController | undefined;
  /** 同一时间至多一个有效余额请求；被替换、完成或清空时复位。 */
  #balanceInFlight = false;
  #disposed = false;
  /** 选择被撤销（登记删除/重验失效）后置位：本运行期不再自动选择，等待用户手动选择。 */
  #manualChoiceRequired = false;
  #rpc: LedgerRpc; #now: () => Date; #visible: () => boolean; #storage?: Pick<Storage, "getItem" | "setItem">;

  constructor(options: AccountsControllerOptions) {
    this.#rpc = options.rpc;
    this.#now = options.now ?? (() => new Date());
    this.#visible = options.visible ?? (() => document.visibilityState === "visible");
    this.#storage = options.storage;
  }

  get state(): AccountsControllerState { return this.#state; }
  subscribe(listener: (state: AccountsControllerState) => void): () => void { this.#listeners.add(listener); listener(this.#state); return () => { this.#listeners.delete(listener); }; }

  /** 页面激活（首次挂载或返回面板）：重取候选并按规则校验选择，再刷新所选账本余额。
   * 余额刷新为后台进行（void），页面挂载点无需等待；迟到的候选/余额结果按各自请求与当前选择丢弃。 */
  async activate(): Promise<void> {
    if (this.#disposed) return;
    if (!this.#state.candidatesLoading) await this.loadCandidates();
    this.#refreshAfterSelection();
  }

  async loadCandidates(): Promise<void> {
    if (this.#disposed) return;
    this.#abortCandidates();
    const request = new AbortController(); this.#candidatesRequest = request;
    this.#state = { ...this.#state, candidatesLoading: true }; this.emit();
    try {
      const { candidates } = await this.#rpc.candidates(request.signal);
      if (!this.#currentCandidates(request)) return;
      this.#applyCandidates(candidates);
    } catch (error) {
      if (!this.#currentCandidates(request)) return;
      // 已有选择时候选失败不阻断余额查询（candidatesError 仅在无选择时呈现）；与零候选可区分。
      this.#state = { ...this.#state, candidatesLoading: false, candidatesError: this.#state.selection ? this.#state.candidatesError : safeMessage(error) };
      this.emit();
    }
  }

  /** 手动选择：立即取消旧余额请求并清空其快照，仅接受候选结果中状态为 candidate 的 ID；
   * 并把该工作区 ID 写入存储供下次访问恢复（写失败降级为仅本次运行期有效）。 */
  async select(workspaceId: string): Promise<void> {
    if (this.#disposed) return;
    const target = this.#state.candidates?.find((item) => item.workspaceId === workspaceId && item.status === "candidate");
    if (!target || workspaceId === this.#state.selection) return;
    this.#manualChoiceRequired = false;
    this.#applySelection(target, false);
    this.#writeStoredWorkspace(workspaceId);
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const selection = this.#state.selection;
    if (!selection || this.#disposed || !this.#visible()) return;
    // 同一时间只有一个有效余额请求：在途时忽略重复触发（手动刷新与轮询重叠亦然）。
    if (this.#balanceInFlight) return;
    this.#abortBalance();
    const request = new AbortController(); this.#balanceRequest = request; this.#balanceInFlight = true;
    this.#state = { ...this.#state, loading: true, error: undefined }; this.emit();
    try {
      const snapshot = await this.#rpc.balances(selection, localDate(this.#now()), request.signal);
      if (!this.#currentBalance(selection, request)) return;
      this.#balanceInFlight = false;
      this.#state = { ...this.#state, snapshot, refreshedAt: this.#now().getTime(), stale: false, loading: false }; this.emit();
    } catch (error) {
      if (!this.#currentBalance(selection, request)) return;
      if (error instanceof BalanceClientError && error.code === "workspace_not_registered") {
        // 宿主确认登记已不存在：与访问拒绝一致——立即清空快照与选择，重取候选并等待用户重新选择。
        this.#balanceInFlight = false;
        this.#manualChoiceRequired = true;
        this.#clearSelection();
        void this.loadCandidates();
        return;
      }
      // 同一账本的临时失败保留旧余额并标记待更新；无快照时呈现可重试错误。
      this.#balanceInFlight = false;
      this.#state = { ...this.#state, loading: false, stale: Boolean(this.#state.snapshot), error: safeMessage(error) }; this.emit();
    }
  }

  /** 手动重试入口：候选失败（或尚未取得）时重取候选；已有选择时重试余额请求。 */
  async retry(): Promise<void> {
    if (this.#disposed) return;
    if (!this.#state.selection) {
      if (!this.#state.candidatesError && this.#state.candidates !== undefined) return;
      await this.loadCandidates();
    }
    this.#refreshAfterSelection();
  }

  dispose(): void { this.#disposed = true; this.#abortCandidates(); this.#abortBalance(); this.#listeners.clear(); }

  /** 选择存在时的统一刷新入口：旧快照先标记待更新，再发起（或在途时合并）余额请求。 */
  #refreshAfterSelection(): void {
    if (!this.#state.selection || this.#disposed) return;
    if (this.#state.snapshot && !this.#state.stale) { this.#state = { ...this.#state, stale: true }; this.emit(); }
    void this.refresh();
  }

  #applyCandidates(candidates: LedgerCandidate[]): void {
    const selected = this.#state.selection;
    const stillValid = selected !== undefined && candidates.some((item) => item.workspaceId === selected && item.status === "candidate");
    if (selected !== undefined && !stillValid) {
      // 所选登记已删除或不再可查：立即清空快照与选择；其余候选即使只剩一个也等待用户重新选择。
      this.#manualChoiceRequired = true;
      this.#state = { ...this.#state, candidates, candidatesLoading: false, candidatesError: undefined };
      this.#clearSelection();
      return;
    }
    this.#state = { ...this.#state, candidates, candidatesLoading: false, candidatesError: undefined };
    if (selected === undefined && !this.#manualChoiceRequired) {
      // 候选查询完成后优先恢复仍可用的手动选择；自动选择只在没有可恢复选择时兜底，且仅本次运行期有效。
      const remembered = this.#readStoredWorkspace();
      if (remembered !== undefined) {
        const restored = candidates.find((item) => item.workspaceId === remembered && item.status === "candidate");
        if (restored) { this.#applySelection(restored, false); return; }
        this.#manualChoiceRequired = true;
      } else {
        const sole = candidates.filter((item) => item.status === "candidate");
        if (sole.length === 1) this.#applySelection(sole[0]!, true);
      }
    }
    this.emit();
  }

  #applySelection(candidate: LedgerCandidate, auto: boolean): void {
    // 切换选择即取消旧余额请求并清空其快照：迟到的旧结果因请求失效而丢弃。
    this.#abortBalance();
    this.#state = { ...this.#state, selection: candidate.workspaceId, selectionTitle: candidate.title, autoSelected: auto, snapshot: undefined, refreshedAt: undefined, stale: false, loading: true, error: undefined };
    this.emit();
  }

  #clearSelection(): void {
    this.#abortBalance();
    this.#state = { ...this.#state, selection: undefined, selectionTitle: undefined, autoSelected: false, snapshot: undefined, refreshedAt: undefined, stale: false, loading: false, error: undefined };
    this.emit();
  }

  #currentCandidates(request: AbortController): boolean { return !this.#disposed && this.#candidatesRequest === request && !request.signal.aborted; }
  #currentBalance(selection: string, request: AbortController): boolean { return !this.#disposed && this.#state.selection === selection && this.#balanceRequest === request && !request.signal.aborted; }
  #abortCandidates(): void { this.#candidatesRequest?.abort(); this.#candidatesRequest = undefined; }
  #abortBalance(): void { this.#balanceRequest?.abort(); this.#balanceRequest = undefined; this.#balanceInFlight = false; }
  /** 存储读写失败一律降级为仅当前页面运行期有效：不得阻断选择与查询（spec 用户故事 9）。 */
  #writeStoredWorkspace(workspaceId: string): void { try { this.#storage?.setItem(WORKSPACE_KEY, workspaceId); } catch { /* 写失败时手动选择仅本次运行期有效 */ } }
  #readStoredWorkspace(): string | undefined { try { return this.#storage?.getItem(WORKSPACE_KEY) || undefined; } catch { return undefined; } }
  private emit(): void { for (const listener of this.#listeners) listener(this.#state); }
}
