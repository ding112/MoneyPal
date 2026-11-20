import type { BalanceSnapshot } from "./balance.js";
// 候选类型以 ledger-registry 为单一来源；本文件只作类型引用（bundle 由本文件单独转译，type-only import 不产生运行时依赖）。
import type { LedgerCandidate, LedgerCandidateStatus } from "./ledger-registry.js";

export class BalanceClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "BalanceClientError"; }
}

/** DSH rpc-host 对非 owner 请求的 owner 专用精确 /api 路由以 HTTP 403 短路拒绝（不带 RPC 信封）。
 * 0.2.x 宿主 asar 实证（0.2.1-rc.2 已核对、0.2.2-rc.5 复核）：connection.rpc.call 把非 2xx 响应抛出为
 * 纯 Error，message 形如 "transport failure for /api/…: HTTP <status>"，没有结构化状态字段。
 * 识别时优先读取错误对象的结构化状态字段（status/statusCode，为宿主未来版本预留；仅在字段为数字时视为权威），
 * 无结构化信号时回退到消息中的状态码。仅 403 是宿主的显式拒绝访问，bundle 据此映射为 workspace_access_denied：
 * 控制器把它与 workspace_not_registered 同等清空余额。其余传输失败（含 401 未认证与 5xx 宿主故障）不视为拒绝，
 * 仍走通用可重试路径，不等同于登记移除。 */
export function rpcAccessDenied(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number") return status === 403;
  return /HTTP 403\b/u.test(error.message);
}

const POLL_MS = 30_000;

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

/* ═══ 独立账户页（ADR-0006）：候选加载、选择规则与余额请求隔离 ═══ */

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

export interface AccountsControllerOptions {
  rpc: LedgerRpc;
  now?: () => Date;
  visible?: () => boolean;
  storage?: Pick<Storage, "getItem" | "setItem">;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

const WORKSPACE_KEY = "dsh-moneypal.accounts-workspace";
/** 宿主确认登记已删除或明确拒绝访问的错误码：与撤销登记同等处理——立即清空快照与选择并等待用户重新选择
 * （spec「首次选择与异常状态」5）。其余错误（连接、候选整体失败、目录离线、布局与运行时）一律保留选择。 */
const REVOKE_CODES: ReadonlySet<string> = new Set(["workspace_not_registered", "workspace_access_denied"]);

/** 独立账户页控制器：候选加载、选择规则、余额请求隔离与刷新全部集中在此处；React 只订阅此状态。
 * 面板激活且标签可见时立即检查所选账本，并每 30 秒轮询；离开面板或隐藏标签时停止轮询并取消在途请求，
 * 恢复时立即检查一次，重合的恢复通知经在途请求合并。 */
export class AccountsController {
  #state: AccountsControllerState = { candidatesLoading: false, autoSelected: false, stale: false, loading: false };
  #listeners = new Set<(state: AccountsControllerState) => void>();
  #candidatesRequest: AbortController | undefined;
  #balanceRequest: AbortController | undefined;
  /** 同一时间至多一个有效余额请求；被替换、完成或清空时复位。 */
  #balanceInFlight = false;
  #disposed = false;
  /** 面板当前是否激活：由 activate/deactivate 维护，轮询与刷新的公共前置条件。 */
  #active = false;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** 选择被撤销（登记删除/重验失效）后置位：本运行期不再自动选择，等待用户手动选择。 */
  #manualChoiceRequired = false;
  #rpc: LedgerRpc; #now: () => Date; #visible: () => boolean; #storage?: Pick<Storage, "getItem" | "setItem">; #schedule: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>; #cancel: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(options: AccountsControllerOptions) {
    this.#rpc = options.rpc;
    this.#now = options.now ?? (() => new Date());
    this.#visible = options.visible ?? (() => document.visibilityState === "visible");
    this.#storage = options.storage;
    this.#schedule = options.schedule ?? ((callback, ms) => setTimeout(callback, ms));
    this.#cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  }

  get state(): AccountsControllerState { return this.#state; }
  subscribe(listener: (state: AccountsControllerState) => void): () => void { this.#listeners.add(listener); listener(this.#state); return () => { this.#listeners.delete(listener); }; }

  /** 页面激活（首次挂载或返回面板）：重取候选并按规则校验选择，再刷新所选账本余额。
   * 余额刷新为后台进行（void），页面挂载点无需等待；迟到的候选/余额结果按各自请求与当前选择丢弃。 */
  async activate(): Promise<void> {
    if (this.#disposed) return;
    this.#active = true;
    if (!this.#state.candidatesLoading) await this.loadCandidates();
    this.#refreshAfterSelection();
  }

  /** 面板失活（宿主卸载独立页组件）：停止轮询并取消在途请求；同一账本的快照保留在页面内存，
   * 返回面板时由 activate 重新检查。失活后 refresh 不再发起新请求，在途响应按失效丢弃。 */
  deactivate(): void {
    if (this.#disposed) return;
    this.#active = false;
    this.#stopPageActivity();
  }

  /** 标签可见性变化：隐藏时停止轮询并取消在途请求；恢复可见且面板激活时立即检查一次。
   * 重合的恢复通知（与面板激活或重复的可见通知）经在途候选/余额请求合并为一次有效刷新。 */
  visibleChanged(): void {
    if (this.#disposed) return;
    if (!this.#visible()) { this.#stopPageActivity(); return; }
    if (!this.#active) return;
    void this.#resumeAfterRecovery();
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
    if (!selection || this.#disposed || !this.#active || !this.#visible()) return;
    // 同一时间只有一个有效余额请求：在途时忽略重复触发（手动刷新与轮询重叠、重合恢复通知亦然）。
    if (this.#balanceInFlight) return;
    this.#abortBalance();
    const request = new AbortController(); this.#balanceRequest = request; this.#balanceInFlight = true;
    this.#state = { ...this.#state, loading: true, error: undefined }; this.emit();
    try {
      const snapshot = await this.#rpc.balances(selection, localDate(this.#now()), request.signal);
      if (!this.#currentBalance(selection, request)) return;
      this.#balanceInFlight = false;
      this.#state = { ...this.#state, snapshot, refreshedAt: this.#now().getTime(), stale: false, loading: false }; this.emit();
      this.#scheduleRefresh(POLL_MS);
    } catch (error) {
      if (!this.#currentBalance(selection, request)) return;
      if (error instanceof BalanceClientError && REVOKE_CODES.has(error.code)) {
        // 宿主确认登记已删除或明确拒绝访问：立即清空快照与选择，重取候选并等待用户重新选择。
        this.#balanceInFlight = false;
        this.#manualChoiceRequired = true;
        this.#clearSelection();
        void this.loadCandidates();
        return;
      }
      // 同一账本的临时失败保留旧余额并标记待更新；无快照时呈现可重试错误。轮询继续以便自动恢复。
      this.#balanceInFlight = false;
      this.#state = { ...this.#state, loading: false, stale: Boolean(this.#state.snapshot), error: safeMessage(error) }; this.emit();
      this.#scheduleRefresh(POLL_MS);
    }
  }

  /** 手动重试入口：无选择时（零候选、非候选引导或候选失败）重新预检候选；已有选择时重试余额请求。
   * 登记、初始化或目录修复完成后，用户无需重开页面即可通过重试触发新的预检。 */
  async retry(): Promise<void> {
    if (this.#disposed) return;
    if (!this.#state.selection) await this.loadCandidates();
    this.#refreshAfterSelection();
  }

  dispose(): void { this.#disposed = true; this.#active = false; this.#abortCandidates(); this.#abortBalance(); this.#cancelPollTimer(); this.#listeners.clear(); }

  /** 选择存在时的统一刷新入口：旧快照先标记待更新，再发起（或在途时合并）余额请求。 */
  #refreshAfterSelection(): void {
    if (!this.#state.selection || this.#disposed) return;
    if (this.#state.snapshot && !this.#state.stale) { this.#state = { ...this.#state, stale: true }; this.emit(); }
    void this.refresh();
  }

  /** 30 秒轮询链：只在面板激活、标签可见且有选择时续期；调度前先取消既有定时器，保证同一时间至多一个。 */
  #scheduleRefresh(ms: number): void {
    this.#cancelPollTimer();
    if (!this.#disposed && this.#active && this.#visible() && this.#state.selection !== undefined && !this.#balanceInFlight) {
      this.#pollTimer = this.#schedule(() => void this.refresh(), ms);
    }
  }
  #cancelPollTimer(): void { if (this.#pollTimer !== undefined) this.#cancel(this.#pollTimer); this.#pollTimer = undefined; }

  /** 离开面板/隐藏标签的统一停止：取消轮询与在途候选、余额请求；在途响应随后按请求失效丢弃，
   * 不改写页面状态、不重启轮询。同账本的旧快照保留，恢复刷新时再标明待更新。 */
  #stopPageActivity(): void {
    this.#cancelPollTimer();
    this.#abortBalance();
    this.#abortCandidates();
    if (this.#state.candidatesLoading || this.#state.loading) {
      this.#state = { ...this.#state, candidatesLoading: false, loading: false };
      this.emit();
    }
  }

  /** 恢复可见的统一检查入口：候选结果缺失（隐藏期间被取消或尚未取得）时补一次候选检查，
   * 随后按当前选择立即刷新；已在途的请求使重合通知合并。 */
  async #resumeAfterRecovery(): Promise<void> {
    if (this.#state.candidates === undefined && !this.#state.candidatesLoading) await this.loadCandidates();
    this.#refreshAfterSelection();
  }

  #applyCandidates(candidates: LedgerCandidate[]): void {
    const selected = this.#state.selection;
    // 只有登记消失（不再出现在候选列表）才视为撤销：立即清空快照与选择，其余候选即使只剩一个也等待用户重新选择。
    // 仍在列表但预检降级（unavailable/invalid_layout/uninitialized）说明登记仍有效：保持选择，
    // 由余额查询呈现具体的可重试结果（spec「首次选择与异常状态」4/6），不自动改选其他候选。
    const stillListed = selected !== undefined && candidates.some((item) => item.workspaceId === selected);
    if (selected !== undefined && !stillListed) {
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
    // 切换选择即取消旧余额请求与既有轮询链并清空其快照：迟到的旧结果因请求失效而丢弃。
    this.#abortBalance();
    this.#cancelPollTimer();
    this.#state = { ...this.#state, selection: candidate.workspaceId, selectionTitle: candidate.title, autoSelected: auto, snapshot: undefined, refreshedAt: undefined, stale: false, loading: true, error: undefined };
    this.emit();
  }

  #clearSelection(): void {
    this.#abortBalance();
    this.#cancelPollTimer();
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

/* ═══ 页面视图模型：bundle 按此渲染；文案键是与 bundle 字典的契约 ═══ */

/** 选择列表项：candidate 可选；其余状态附状态标签与引导键（初始化引导 / 检查目录 / 重试）。 */
export interface PageCandidateItem extends LedgerCandidate { selectable: boolean; statusKey?: string; guideKey?: string; }

export type PageBodyView =
  | { kind: "details" }
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "retryable"; message: string }
  | { kind: "zero" }
  | { kind: "choice"; items: PageCandidateItem[] };

const CHOICE_GUIDE: Record<Exclude<LedgerCandidateStatus, "candidate">, string> = {
  uninitialized: "choice.guide.uninitialized",
  invalid_layout: "choice.guide.invalid_layout",
  unavailable: "choice.guide.unavailable",
};

function candidateItem(item: LedgerCandidate): PageCandidateItem {
  if (item.status === "candidate") return { ...item, selectable: true };
  return { ...item, selectable: false, statusKey: `choice.status.${item.status}`, guideKey: CHOICE_GUIDE[item.status] };
}

/** 页面正文判定（顺序固定）：快照（空余额单独成态）→ 选择内加载/失败 → 候选加载/失败 → 零候选引导 → 选择列表。
 * 空余额与零候选是不同状态；retryable 携带可重试错误的安全文案。 */
export function pageBodyView(state: AccountsControllerState): PageBodyView {
  const snapshot = state.snapshot;
  if (snapshot) {
    const empty = !snapshot.assets.accounts.length && !snapshot.liabilities.accounts.length;
    if (empty && !state.loading) return { kind: "empty" };
    return { kind: "details" };
  }
  if (state.selection) {
    if (state.loading) return { kind: "loading" };
    if (state.error) return { kind: "retryable", message: state.error };
    return { kind: "loading" };
  }
  if (state.candidatesLoading) return { kind: "loading" };
  if (state.candidatesError) return { kind: "retryable", message: state.candidatesError };
  const candidates = state.candidates ?? [];
  if (!candidates.length) return { kind: "zero" };
  return { kind: "choice", items: candidates.map(candidateItem) };
}

export type PageFooterDot = "neutral" | "warning" | "success";
export interface PageFooterStatus { key: string; dot: PageFooterDot; }

/** 页脚唯一状态模型：自上而下首项命中，同时给出文案键与圆点类型；圆点仅是视觉辅助（aria-hidden），
 * 含义由文字表达。文案键与 bundle 字典的 footer.* 一一对应，与 pageBodyView 同为领域层判定。 */
export function pageFooterStatus(state: AccountsControllerState): PageFooterStatus {
  if (state.error || state.candidatesError) return { key: "footer.refreshFailed", dot: "warning" };
  if (state.loading) return { key: state.snapshot ? "footer.refreshing" : "footer.waitingLedger", dot: "neutral" };
  if (state.stale) return { key: "footer.stale", dot: "warning" };
  if (state.snapshot && !state.snapshot.assets.accounts.length && !state.snapshot.liabilities.accounts.length) return { key: "footer.noData", dot: "neutral" };
  if (state.snapshot) return { key: "footer.updated", dot: "success" };
  if (state.candidates?.length) return { key: "footer.awaiting", dot: "neutral" };
  return { key: "footer.zero", dot: "neutral" };
}
