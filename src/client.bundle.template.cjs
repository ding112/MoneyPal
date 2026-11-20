/* DSH Web lazy CommonJS 工厂（独立账户页：sidebar.panellist 入口 + main 主区面板，接替会话标题栏余额入口与抽屉）。
 * 分层：文案与 locale 注册 → 展示组件（纯函数，状态与文案经 props 注入）→ 样式安装 → DSH 接入（apply）。
 * 业务状态由编译后的 AccountsController 单点管理；样式来自 src/client.css。
 * 文案注册到宿主 LocaleRuntime（@deepseek-ai/dsh-client-locale 0.1.2-rc.1 已核验：
 * ctx.provide("locale")、register(ns, {zh, en}) 返回 disposer、bind(ns) 返回实时翻译函数、
 * 查找链 ns → common → key；locale id 仅 zh/en，zh 为 key 基准）。 */
window.__ModuleLoader__.load({ id: "dsh-moneypal", factory: (require) => {
  const module = { exports: {} }; const React = require("react");
  const runtime = (() => { const exports = {}; const module = { exports }; /*__CLIENT_RUNTIME__*/ return module.exports; })();

  /* ═══ 文案：单一来源字典，注册到宿主 locale 命名空间，跟随宿主语言切换 ═══ */
  const LOCALE_NS = "dsh-moneypal.accounts";
  const ZH = {
    "panel.title": "恰恰账本",
    "page.title": "恰恰账本",
    "page.asOf": "截至 {date}",
    "page.refresh": "刷新余额",
    "page.recheck": "重新检测账本",
    "group.assets": "资产",
    "group.liabilities": "负债",
    "group.count": "{count} 个账户",
    "total.assets": "资产合计",
    "total.liabilities": "负债合计",
    "overview.caption": "不同商品分别列示，不进行折算。",
    "debt.displayNote": "按欠款金额展示",
    "debt.overpaid": "{count} 个账户存在溢缴款",
    "warn.overdrawn": "已透支",
    "warn.overpaid": "溢缴款 · 已多还",
    "loading.note": "正在读取账户余额…",
    "empty.title": "暂无账户余额",
    "empty.description": "当前账本没有非零的资产或负债余额。",
    "zero.title": "尚未发现账本",
    "zero.description": "在 DSH 中登记账本工作区后，即可在此查看余额。",
    "error.title": "暂时无法读取余额",
    "error.fallback": "请检查账本状态，然后刷新余额。",
    "action.refresh": "刷新余额",
    "action.retry": "重试",
    "choice.title": "选择要查看的账本",
    "choice.status.uninitialized": "未初始化",
    "choice.status.invalid_layout": "目录不完整",
    "choice.status.unavailable": "暂时不可访问",
    "choice.guide.uninitialized": "请在该工作区打开 MoneyPal 会话，按预览确认完成初始化。",
    "choice.guide.invalid_layout": "请检查该工作区的现有账本目录。",
    "choice.guide.unavailable": "工作区暂时无法访问，请稍后重试。",
    "banner.failedWithTime": "刷新失败，显示 {time} 的余额",
    "banner.failedNoTime": "刷新失败，显示的余额可能已过期。",
    "banner.pending": "余额可能已过期，正在获取最新数据。",
    "footer.refreshFailed": "刷新失败",
    "footer.refreshing": "正在刷新…",
    "footer.waitingLedger": "等待账本响应",
    "footer.stale": "余额待更新",
    "footer.noData": "暂无余额数据",
    "footer.updated": "余额已更新",
    "footer.updatedAt": "{time} 更新",
    "footer.lastSuccess": "上次成功 {time}",
    "footer.awaiting": "等待选择账本",
    "footer.zero": "没有可查看的账本",
  };
  const EN = {
    "panel.title": "MoneyPal Ledger",
    "page.title": "MoneyPal Ledger",
    "page.asOf": "As of {date}",
    "page.refresh": "Refresh balances",
    "page.recheck": "Re-check ledgers",
    "group.assets": "Assets",
    "group.liabilities": "Liabilities",
    "group.count": "Accounts: {count}",
    "total.assets": "Total assets",
    "total.liabilities": "Total liabilities",
    "overview.caption": "Commodities are listed separately and never converted.",
    "debt.displayNote": "Shown as amounts owed",
    "debt.overpaid": "Accounts with overpayments: {count}",
    "warn.overdrawn": "Overdrawn",
    "warn.overpaid": "Overpaid · refund due",
    "loading.note": "Reading account balances…",
    "empty.title": "No account balances",
    "empty.description": "The current ledger has no non-zero asset or liability balances.",
    "zero.title": "No ledger found",
    "zero.description": "Register a ledger workspace in DSH to view balances here.",
    "error.title": "Balances unavailable",
    "error.fallback": "Check the ledger state, then refresh balances.",
    "action.refresh": "Refresh balances",
    "action.retry": "Retry",
    "choice.title": "Choose a ledger",
    "choice.status.uninitialized": "Not initialized",
    "choice.status.invalid_layout": "Incomplete layout",
    "choice.status.unavailable": "Temporarily unreachable",
    "choice.guide.uninitialized": "Open a MoneyPal session in this workspace and confirm the preview to initialize it.",
    "choice.guide.invalid_layout": "Check the existing ledger directory in this workspace.",
    "choice.guide.unavailable": "The workspace is temporarily unreachable; please retry later.",
    "banner.failedWithTime": "Refresh failed, showing balances from {time}",
    "banner.failedNoTime": "Refresh failed, the balances shown may be outdated.",
    "banner.pending": "Balances may be outdated; fetching the latest data.",
    "footer.refreshFailed": "Refresh failed",
    "footer.refreshing": "Refreshing…",
    "footer.waitingLedger": "Waiting for the ledger",
    "footer.stale": "Balances need updating",
    "footer.noData": "No balance data",
    "footer.updated": "Balances updated",
    "footer.updatedAt": "Updated {time}",
    "footer.lastSuccess": "Last success {time}",
    "footer.awaiting": "Waiting for a ledger choice",
    "footer.zero": "No ledger to view",
  };
  function fill(template, params) {
    return params ? template.replace(/\{(\w+)\}/gu, (whole, key) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole) : template;
  }
  function setupLocale(ctx) {
    const locale = ctx.locale;
    if (!locale || typeof locale.register !== "function" || typeof locale.bind !== "function") {
      throw new Error("dsh-moneypal client requires the DSH locale service; declare it in the bundle inject list.");
    }
    const dispose = locale.register(LOCALE_NS, { zh: ZH, en: EN });
    return {
      dispose,
      t: locale.bind(LOCALE_NS),
      // LocaleFace 快照携带 revision，locale 切换或字典注册都会推进；useSyncExternalStore 订阅后文案实时刷新。
      subscribe: (listener) => locale.subscribe(listener),
      getSnapshot: () => locale.getLocale(),
    };
  }

  /* ═══ 展示组件：纯函数；不读取模块状态，state/t/回调全部经 props 注入 ═══ */
  const NS = "dsh-moneypal-balance"; const STYLE_ID = `${NS}-style`;
  // DSH 面板 ID：sidebar.panellist 条目与 main keyed 条目共用（ADR-0006 的同一面板 ID）。
  const PANEL_ID = "dsh-moneypal-accounts";
  const cls = (...parts) => parts.filter(Boolean).map((part) => `${NS}-${part}`).join(" ");
  // 展示格式跟随宿主 locale；时钟保留浏览器本地时区。
  const fmtClock = (ms, locale = "zh-CN") => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
  // 截至日期按 YYYY-MM-DD 拆分后以 UTC 构造并固定 timeZone: "UTC"，本地时区偏移不得使日期跨天；
  // setUTCFullYear 避免 Date 构造器对 0–99 年的 1900 基准特殊处理。
  const fmtAsOf = (asOf, locale = "zh-CN") => {
    const [year, month, day] = asOf.split("-");
    if (!year || !month || !day) return asOf;
    const date = new Date(0);
    date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    return new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "UTC" }).format(date);
  };

  function Amount({ amount, liability, warning, t, locale }) {
    if (!amount) return React.createElement("span", { className: cls("amount", "amount-empty") }, "—");
    const parts = runtime.formatAmountParts(amount, liability, locale);
    return React.createElement("span", { className: cls("amount") },
      React.createElement("span", { className: cls("amount-value", parts.negative && "negative") }, parts.value),
      // 商品标识（币种代码）是账本记号，禁止机器翻译。
      React.createElement("span", { className: cls("currency"), translate: "no" }, parts.currency),
      warning && parts.negative ? React.createElement("span", { className: cls("amount-warning") }, warning) : null);
  }
  function Icon({ label, onClick, disabled }) {
    const paths = ["M20 7v5h-5M4 17v-5h5", "M6 7a7 7 0 0 1 12 0l2 5M4 12l2 5a7 7 0 0 0 12 0"];
    return React.createElement("button", { type: "button", className: cls("icon"), "aria-label": label, onClick, disabled }, React.createElement("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, paths.map((d) => React.createElement("path", { key: d, d }))));
  }
  function accountParts(account) { const parts = account.split(":"); const name = parts.at(-1) || account; return { name, path: parts.slice(1, -1).join(":") }; }
  function AccountRow({ account, liability, t, locale }) {
    const { name, path } = accountParts(account.account);
    // 账户名与路径是账本记号，整体容器禁止机器翻译；明细路径置于容器内继承该属性。
    return React.createElement("div", { className: cls("account") },
      React.createElement("span", { className: cls("name"), title: account.account, translate: "no" }, name, path ? React.createElement("span", { className: cls("path") }, path) : null),
      React.createElement("span", { className: cls("account-values") }, account.amounts.map((amount, index) => React.createElement(Amount, { key: `${amount.commodity}-${amount.quantity}-${index}`, amount, liability, warning: liability ? t("warn.overpaid") : t("warn.overdrawn"), t, locale }))));
  }
  function Summary({ title, data, liability, t, locale }) {
    const totals = data?.totals ?? []; const accounts = data?.accounts ?? [];
    const overpaid = liability ? accounts.filter((account) => account.amounts.some((amount) => !amount.quantity.startsWith("-"))).length : 0;
    return React.createElement("section", { className: cls("section-block", liability && "debt") },
      React.createElement("div", { className: cls("section-label") },
        React.createElement("h3", null, title),
        React.createElement("em", null, t("group.count", { count: accounts.length }))),
      React.createElement("p", { className: cls("total-main") }, React.createElement(Amount, { amount: totals[0], liability, t, locale })),
      totals.length > 1 ? React.createElement("p", { className: cls("total-secondary") }, totals.slice(1).map((amount, index) => React.createElement(Amount, { key: `${amount.commodity}-${index}`, amount, liability, t, locale }))) : null,
      liability ? React.createElement("p", { className: cls("inline-info") },
        React.createElement("span", null, t("debt.displayNote")),
        overpaid ? React.createElement("span", null, t("debt.overpaid", { count: overpaid })) : null) : null);
  }
  function Details({ snapshot, t, locale }) {
    // 账户总数超过 50 时为明细分组附加渲染优化修饰类：仅影响分组内账户行的绘制，DOM 仍完整保留。
    const large = snapshot.assets.accounts.length + snapshot.liabilities.accounts.length > 50;
    const group = (title, data, liability, totalLabel) => React.createElement("section", { key: title, className: cls("group", liability && "debt", large && "group-large") },
      React.createElement("div", { className: cls("group-head") }, React.createElement("h3", null, title), React.createElement("small", null, t("group.count", { count: data.accounts.length }))),
      data.accounts.map((account) => React.createElement(AccountRow, { key: account.account, account, liability, t, locale })),
      React.createElement("p", { className: cls("group-total") },
        React.createElement("span", null, totalLabel),
        React.createElement("span", { className: cls("account-values") }, data.totals.map((amount, index) => React.createElement(Amount, { key: `${amount.commodity}-${index}`, amount, liability, t, locale })))));
    return React.createElement(React.Fragment, null,
      group(t("group.assets"), snapshot.assets, false, t("total.assets")),
      group(t("group.liabilities"), snapshot.liabilities, true, t("total.liabilities")));
  }
  function LoadingBody({ t }) {
    const widths = ["85%", "50%", "100%", "100%", "70%", "100%", "90%"];
    return React.createElement("div", null,
      React.createElement("div", { className: cls("loading-note") }, t("loading.note")),
      widths.map((width, index) => React.createElement("div", { key: index, className: cls("skeleton"), style: { width, height: index === 1 ? "34px" : "16px" } })));
  }
  function StateBody({ title, description, action, alert = false, onAction }) {
    return React.createElement("div", { className: cls("state-message") },
      React.createElement("h3", null, title),
      React.createElement("div", alert ? { role: "alert" } : undefined, description),
      action ? React.createElement("button", { type: "button", className: cls("state-action"), onClick: onAction }, action) : null);
  }
  function Banner({ state, onRetry, t, locale }) {
    // 刷新失败与待更新共用警示横幅：保留快照并给出可重试入口，仅重新请求期间显示“获取最新数据”。
    const failed = state.error;
    const message = failed
      ? (state.refreshedAt ? t("banner.failedWithTime", { time: fmtClock(state.refreshedAt, locale) }) : t("banner.failedNoTime"))
      : t("banner.pending");
    return React.createElement("div", { className: cls("banner") },
      React.createElement("p", { role: failed ? "alert" : undefined }, message),
      React.createElement("button", { type: "button", className: cls("banner-retry"), onClick: onRetry }, t("action.retry")));
  }
  /* 选择列表（渲染 pageBodyView 的 choice 视图）：手动选择经 AccountsController 持久化到 localStorage，下次访问自动恢复；
   * 只有 candidate 项可选；非候选项展示状态标签与对应引导（初始化 / 检查目录 / 重试）；同名候选展示宿主生成的目录提示。 */
  function ChoiceList({ items, onSelect, t }) {
    return React.createElement("div", { className: cls("choice") },
      React.createElement("h3", null, t("choice.title")),
      items.map((item) => React.createElement("button", { key: item.workspaceId, type: "button", className: cls("choice-item"), disabled: !item.selectable, onClick: () => item.selectable && onSelect(item.workspaceId) },
        React.createElement("span", { className: cls("choice-name"), translate: "no" }, item.title),
        item.directoryHint ? React.createElement("span", { className: cls("choice-hint"), translate: "no" }, item.directoryHint) : null,
        item.selectable ? null : React.createElement("span", { className: cls("choice-status") }, t(item.statusKey)),
        item.selectable ? null : React.createElement("span", { className: cls("choice-guide") }, t(item.guideKey)))));
  }
  function PageHeader({ state, onRefresh, t, locale }) {
    const snapshot = state.snapshot;
    return React.createElement("header", { className: cls("toolbar") },
      React.createElement("div", { className: cls("title") },
        React.createElement("h2", null, t("page.title")),
        React.createElement("small", { className: cls("subtitle") },
          state.selectionTitle ? React.createElement("span", { className: cls("ledger-name"), translate: "no" }, state.selectionTitle) : null,
          snapshot ? React.createElement("span", null, t("page.asOf", { date: fmtAsOf(snapshot.asOf, locale) })) : null)),
      React.createElement(Icon, { label: state.selection ? t("page.refresh") : t("page.recheck"), onClick: onRefresh, disabled: state.loading || state.candidatesLoading }));
  }
  function freshLabel({ state, snapshot, t, locale }) {
    if (!snapshot) return "—";
    if (state.stale) return state.refreshedAt ? t("footer.lastSuccess", { time: fmtClock(state.refreshedAt, locale) }) : "—";
    return state.refreshedAt ? t("footer.updatedAt", { time: fmtClock(state.refreshedAt, locale) }) : "—";
  }
  /* 页面正文：判定顺序集中在 runtime.pageBodyView（固定顺序、领域层测试覆盖），此处只做状态到元素的映射。
   * 空账本（empty）与“尚未发现账本”（zero）是不同状态、不同文案；retryable 携带宿主净化的安全文案。 */
  function pageBodyFor({ state, onRefresh, onRetry, onSelect, t, locale }) {
    const view = runtime.pageBodyView(state);
    if (view.kind === "details") {
      const snapshot = state.snapshot;
      const multipleCommodities = new Set([...snapshot.assets.totals, ...snapshot.liabilities.totals].map((amount) => amount.commodity)).size > 1;
      return React.createElement(React.Fragment, null,
        React.createElement(Details, { snapshot, t, locale }),
        multipleCommodities ? React.createElement("p", { className: cls("caption-line") }, t("overview.caption")) : null);
    }
    if (view.kind === "empty") return StateBody({ title: t("empty.title"), description: t("empty.description"), action: t("action.refresh"), onAction: onRefresh });
    if (view.kind === "retryable") return StateBody({ title: t("error.title"), description: view.message, action: t("action.retry"), alert: true, onAction: onRetry });
    if (view.kind === "zero") return StateBody({ title: t("zero.title"), description: t("zero.description") });
    if (view.kind === "choice") return ChoiceList({ items: view.items, onSelect, t });
    return LoadingBody({ t });
  }

  /* ═══ 样式安装：命名空间 style 标签；安装/卸载均由宿主生命周期持有 ═══ */
  const CLIENT_STYLES = "__CLIENT_STYLES__";
  function installStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style"); style.id = STYLE_ID;
    style.textContent = CLIENT_STYLES;
    document.head.append(style);
  }
  function removeStyle() { document.getElementById(STYLE_ID)?.remove(); }

  /* ═══ DSH 接入：RPC 适配、controller、panel 注册与生命周期 ═══ */
  const callError = (error) => new runtime.BalanceClientError(error?.code ?? "balance_unavailable", error?.message ?? "暂时无法读取账户余额，请重试。");
  const INJECT = ["slots", "connection", "locale"];

  function apply(ctx) {
    installStyle();
    ctx.effect(() => removeStyle, `${NS}.style()`);
    /* 宿主对 owner 专用精确 /api 路由的访问拒绝不带 RPC 信封：非 owner 请求被 DSH rpc-host 以 HTTP 403 短路拒绝
     * （0.2.1-rc.2 已核对），connection.rpc.call 抛出携带状态码的传输错误。识别后映射为 workspace_access_denied，
     * 控制器把它与 workspace_not_registered 同等清空；其余传输失败（含 401 与 5xx）保持原样走可重试路径，不等同于登记移除。
     * 适配器持有 apply 注入的 ctx：模块作用域没有 ctx，抽出去会成为运行时 ReferenceError。 */
    const rpcCall = async (method, payload, signal) => {
      try { return await ctx.connection.rpc.call("/api", method, payload, signal); }
      catch (error) {
        if (runtime.rpcAccessDenied(error)) throw new runtime.BalanceClientError("workspace_access_denied", "宿主拒绝了本次访问，请稍后重试。");
        throw error;
      }
    };
    const controller = new runtime.AccountsController({
      rpc: {
        candidates: async (signal) => { const outer = await rpcCall("dsh-moneypal/ledger-candidates", {}, signal); if (!outer?.ok) throw callError(); const inner = outer.value; if (!inner?.ok) throw callError(inner?.error); return inner.value; },
        balances: async (workspaceId, asOf, signal) => { const outer = await rpcCall("dsh-moneypal/ledger-balances", { workspaceId, asOf }, signal); if (!outer?.ok) throw callError(); const inner = outer.value; if (!inner?.ok) throw callError(inner?.error); return inner.value; },
      },
      // 手动选择的工作区 ID 持久化到浏览器 localStorage；受限浏览器的属性访问也可能抛错，整体降级为仅本次运行期有效。
      storage: (() => { try { return window.localStorage; } catch { return undefined; } })(),
      visible: () => document.visibilityState === "visible",
    });
    ctx.effect(() => () => controller.dispose(), `${NS}.accountsController()`);
    const face = setupLocale(ctx);
    ctx.effect(() => face.dispose, `${NS}.locale()`);

    function useAccountsState() { return React.useSyncExternalStore((listener) => controller.subscribe(listener), () => controller.state); }
    // 页面订阅 locale 快照：宿主切换语言时触发重渲染，face.t 实时翻译函数随之输出新文案。
    // 语言来源为宿主 LocaleRuntime 的 active 值（已验证），映射为 BCP 47 供 Intl 格式化使用；未知值回退中文。
    function useLocale() {
      const snapshot = React.useSyncExternalStore(face.subscribe, face.getSnapshot);
      return { t: face.t, locale: snapshot?.active === "en" ? "en-US" : "zh-CN" };
    }

    /* 左侧栏入口图标：财务语义明确的钱包图形（原生 SVG，不引入图标库）；
     * 选中态与点击行为由宿主 sidebar 管理，组件只按宿主传入的 size 绘制。 */
    function PanelIcon({ size }) {
      return React.createElement("svg", { viewBox: "0 0 24 24", width: size ?? 20, height: size ?? 20, "aria-hidden": "true", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round" },
        React.createElement("path", { d: "M20 7V5a2 2 0 0 0-2-2H5a4 4 0 0 0 0 8h15" }),
        React.createElement("path", { d: "M5 7h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a4 4 0 0 1-4-4V7" }),
        React.createElement("path", { d: "M16 13h6v4h-6a2 2 0 0 1 0-4Z" }));
    }

    function AccountsPage() {
      const state = useAccountsState();
      const { t, locale } = useLocale();
      // 挂载即激活：候选重验 → 选择规则 → 余额刷新。DSH 主区按 activePanelId 渲染 keyed 面板，
      // 离开面板时宿主卸载本组件，清理回调让控制器停止轮询并取消在途请求（同账本快照保留在页面内存）。
      // 标签可见性驱动轮询：隐藏时停止并取消在途请求，恢复可见且面板激活时立即检查一次；
      // 与面板激活重合的恢复通知由控制器经在途请求合并为一次有效刷新。
      React.useEffect(() => {
        void controller.activate();
        const onVisibilityChange = () => controller.visibleChanged();
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
          document.removeEventListener("visibilitychange", onVisibilityChange);
          controller.deactivate();
        };
      }, []);
      // 手动刷新唯一入口：读取最新控制器状态；页面隐藏或在途时忽略。
      // 有选择 → 刷新余额；无选择（零候选、非候选引导或候选失败）→ 重新预检候选。
      const reload = () => {
        const current = controller.state;
        if (document.visibilityState !== "visible") return;
        if (current.selection) { if (!current.loading) void controller.refresh(); return; }
        if (!current.candidatesLoading) void controller.retry();
      };
      // 页脚状态判定集中在 runtime.pageFooterStatus（固定顺序、领域层测试覆盖），此处只做状态到元素的映射。
      const status = runtime.pageFooterStatus(state);
      return React.createElement("div", { className: cls("page") },
        React.createElement(PageHeader, { state, onRefresh: reload, t, locale }),
        state.snapshot && state.stale ? React.createElement(Banner, { state, onRetry: reload, t, locale }) : null,
        React.createElement("div", { className: cls("content") },
          pageBodyFor({ state, onRefresh: reload, onRetry: reload, onSelect: (workspaceId) => void controller.select(workspaceId), t, locale })),
        React.createElement("footer", { className: cls("footer") },
          React.createElement("span", null, React.createElement("i", { className: cls("dot", `dot-${status.dot}`), "aria-hidden": "true" }), t(status.key)),
          React.createElement("span", null, freshLabel({ state, snapshot: state.snapshot, t, locale }))));
    }

    /* ADR-0006：同一面板 ID 同时注册 sidebar.panellist（入口显示与激活）与 main（主区面板）；
     * 激活状态、入口显示与会话导航全部由 DSH 管理。 */
    ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 20, locale: LOCALE_NS, label: () => face.t("panel.title") }, PanelIcon));
    ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID, locale: LOCALE_NS }, AccountsPage));
  }

  module.exports.apply = apply; module.exports.inject = INJECT; return module.exports;
}});
