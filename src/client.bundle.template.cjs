/* DSH Web lazy CommonJS 工厂（A 方案：概览/明细双页签）。
 * 分层：文案与 locale 注册 → 展示组件（纯函数，状态与文案经 props 注入）→ 样式安装 → DSH 接入（apply）。
 * 业务状态仍由编译后的 BalanceController 单点管理；样式来自 src/client.css。
 * 文案注册到宿主 LocaleRuntime（@deepseek-ai/dsh-client-locale 0.1.1-rc.2 已核验：
 * ctx.provide("locale")、register(ns, {zh, en}) 返回 disposer、bind(ns) 返回实时翻译函数、
 * 查找链 ns → common → key；locale id 仅 zh/en，zh 为 key 基准）。 */
window.__ModuleLoader__.load({ id: "dsh-moneypal", factory: (require) => {
  const module = { exports: {} }; const React = require("react");
  const runtime = (() => { const exports = {}; const module = { exports }; /*__CLIENT_RUNTIME__*/ return module.exports; })();

  /* ═══ 文案：单一来源字典，注册到宿主 locale 命名空间，跟随宿主语言切换 ═══ */
  const LOCALE_NS = "dsh-moneypal.balance";
  const ZH = {
    "entry.label": "余额",
    "entry.aria": "查看账户余额",
    "drawer.title": "账户余额",
    "drawer.asOf": "截至 {date}",
    "drawer.refresh": "刷新余额",
    "drawer.close": "关闭账户余额",
    "drawer.label": "账户余额",
    "tabs.label": "余额视图",
    "tab.overview": "概览",
    "tab.details": "明细",
    "group.assets": "资产",
    "group.liabilities": "负债",
    "group.count": "{count} 个账户",
    "total.assets": "资产合计",
    "total.liabilities": "负债合计",
    "overview.list": "账户一览",
    "overview.listCount": "共 {count} 个",
    "overview.jump": "查看全部账户明细",
    "overview.caption": "不同币种分别列示，不进行折算。",
    "debt.displayNote": "按欠款金额展示",
    "debt.overpaid": "{count} 个账户存在溢缴款",
    "warn.overdrawn": "已透支",
    "warn.overpaid": "溢缴款 · 已多还",
    "loading.note": "正在读取账户余额…",
    "empty.title": "暂无账户余额",
    "empty.description": "当前账本没有非零的资产或负债余额。",
    "error.title": "暂时无法读取余额",
    "error.fallback": "请检查账本状态，然后重新读取。",
    "action.refresh": "刷新余额",
    "action.reread": "重新读取",
    "action.retry": "重试",
    "banner.failedWithTime": "刷新失败，显示 {time} 的余额",
    "banner.failedNoTime": "刷新失败，显示的余额可能已过期。",
    "banner.pending": "余额可能已过期，正在获取最新数据。",
    "status.refreshing": "正在刷新…",
    "status.waitingLedger": "等待账本响应",
    "status.waitingBalance": "等待余额",
    "status.autoRefresh": "每 30 秒自动刷新",
    "status.updatedAt": "{time} 更新",
    "status.lastSuccess": "上次成功 {time}",
  };
  const EN = {
    "entry.label": "Balances",
    "entry.aria": "View account balances",
    "drawer.title": "Account Balances",
    "drawer.asOf": "As of {date}",
    "drawer.refresh": "Refresh balances",
    "drawer.close": "Close account balances",
    "drawer.label": "Account balances",
    "tabs.label": "Balance view",
    "tab.overview": "Overview",
    "tab.details": "Details",
    "group.assets": "Assets",
    "group.liabilities": "Liabilities",
    "group.count": "{count} accounts",
    "total.assets": "Total assets",
    "total.liabilities": "Total liabilities",
    "overview.list": "Accounts",
    "overview.listCount": "{count} total",
    "overview.jump": "View all account details",
    "overview.caption": "Commodities are listed separately and never converted.",
    "debt.displayNote": "Shown as amounts owed",
    "debt.overpaid": "{count} accounts have overpayments",
    "warn.overdrawn": "Overdrawn",
    "warn.overpaid": "Overpaid · refund due",
    "loading.note": "Reading account balances…",
    "empty.title": "No account balances",
    "empty.description": "The current ledger has no non-zero asset or liability balances.",
    "error.title": "Balances unavailable",
    "error.fallback": "Check the ledger state, then read again.",
    "action.refresh": "Refresh balances",
    "action.reread": "Read again",
    "action.retry": "Retry",
    "banner.failedWithTime": "Refresh failed, showing balances from {time}",
    "banner.failedNoTime": "Refresh failed, the balances shown may be outdated.",
    "banner.pending": "Balances may be outdated; fetching the latest data.",
    "status.refreshing": "Refreshing…",
    "status.waitingLedger": "Waiting for the ledger",
    "status.waitingBalance": "Waiting for balances",
    "status.autoRefresh": "Auto-refreshes every 30 s",
    "status.updatedAt": "Updated {time}",
    "status.lastSuccess": "Last success {time}",
  };
  function fill(template, params) {
    return params ? template.replace(/\{(\w+)\}/gu, (whole, key) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole) : template;
  }
  const localT = (key, params) => fill(ZH[key] ?? key, params);
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
  const NS = "dsh-moneypal-balance"; const STYLE_ID = `${NS}-style`; const TITLE_ID = `${NS}-title`;
  const DRAWER_ID = `${NS}-drawer`; const TAB_PREFIX = `${NS}-tab`; const PANEL_ID = `${NS}-panel`;
  const TABS = [["overview", "tab.overview"], ["details", "tab.details"]];
  const COMPACT_QUERY = "(max-width: 767px)";
  const cls = (...parts) => parts.filter(Boolean).map((part) => `${NS}-${part}`).join(" ");
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const fmtAsOf = (asOf) => asOf.replaceAll("-", ".");

  function Entry({ open, t, onActivate }) {
    return React.createElement("button", {
      type: "button", className: `${NS}-entry`, "aria-label": t("entry.aria"),
      "aria-expanded": open, "aria-controls": DRAWER_ID,
      onClick: (event) => onActivate(event),
    }, t("entry.label"));
  }
  function Amount({ amount, liability, warning, t }) {
    if (!amount) return React.createElement("span", { className: cls("amount", "amount-empty") }, "—");
    const parts = runtime.formatAmountParts(amount, liability);
    return React.createElement("span", { className: cls("amount") },
      React.createElement("span", { className: cls("amount-value", parts.negative && "negative") }, parts.value),
      React.createElement("span", { className: cls("currency") }, parts.currency),
      warning && parts.negative ? React.createElement("span", { className: cls("amount-warning") }, warning) : null);
  }
  function Icon({ kind, label, onClick, disabled }) {
    const paths = kind === "refresh" ? ["M20 7v5h-5M4 17v-5h5", "M6 7a7 7 0 0 1 12 0l2 5M4 12l2 5a7 7 0 0 0 12 0"] : ["m6 6 12 12M18 6 6 18"];
    return React.createElement("button", { type: "button", className: cls("icon"), "aria-label": label, onClick, disabled }, React.createElement("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" }, paths.map((d) => React.createElement("path", { key: d, d }))));
  }
  function accountParts(account) { const parts = account.split(":"); const name = parts.at(-1) || account; return { name, path: parts.slice(1, -1).join(":") }; }
  function AccountRow({ account, liability, t, mini = false }) {
    const { name, path } = accountParts(account.account);
    if (mini) {
      return React.createElement("div", { className: cls("mini-row") },
        React.createElement("span", { className: cls("mini-name"), title: account.account }, name),
        React.createElement(Amount, { amount: account.amounts[0], liability, t }));
    }
    return React.createElement("div", { className: cls("account") },
      React.createElement("span", { className: cls("name"), title: account.account }, name, path ? React.createElement("span", { className: cls("path") }, path) : null),
      React.createElement("span", { className: cls("account-values") }, account.amounts.map((amount, index) => React.createElement(Amount, { key: `${amount.commodity}-${amount.quantity}-${index}`, amount, liability, warning: liability ? t("warn.overpaid") : t("warn.overdrawn"), t }))));
  }
  function Summary({ title, data, liability, t }) {
    const totals = data?.totals ?? []; const accounts = data?.accounts ?? [];
    const overpaid = liability ? accounts.filter((account) => account.amounts.some((amount) => !amount.quantity.startsWith("-"))).length : 0;
    return React.createElement("section", { className: cls("section-block", liability && "debt") },
      React.createElement("div", { className: cls("section-label") },
        React.createElement("i", { className: cls("marker"), "aria-hidden": "true" }), title,
        React.createElement("em", null, t("group.count", { count: accounts.length }))),
      React.createElement("div", { className: cls("totals") },
        React.createElement("p", { className: cls("total-main") }, React.createElement(Amount, { amount: totals[0], liability, t })),
        totals.length > 1 ? React.createElement("p", { className: cls("total-secondary") }, totals.slice(1).map((amount, index) => React.createElement(Amount, { key: `${amount.commodity}-${index}`, amount, liability, t }))) : null),
      liability ? React.createElement("p", { className: cls("inline-info") },
        React.createElement("span", null, t("debt.displayNote")),
        overpaid ? React.createElement("span", null, t("debt.overpaid", { count: overpaid })) : null) : null);
  }
  function Overview({ snapshot, onDetails, t }) {
    const preview = [...snapshot.assets.accounts.map((account) => ({ account, liability: false })), ...snapshot.liabilities.accounts.map((account) => ({ account, liability: true }))].slice(0, 3);
    const count = snapshot.assets.accounts.length + snapshot.liabilities.accounts.length;
    return React.createElement(React.Fragment, null,
      React.createElement(Summary, { title: t("group.assets"), data: snapshot.assets, liability: false, t }), React.createElement(Summary, { title: t("group.liabilities"), data: snapshot.liabilities, liability: true, t }),
      React.createElement("div", { className: cls("section-label") }, t("overview.list"), React.createElement("em", null, t("overview.listCount", { count }))),
      preview.map(({ account, liability }) => React.createElement(AccountRow, { key: account.account, account, liability, mini: true, t })),
      React.createElement("button", { type: "button", className: cls("jump"), onClick: onDetails }, React.createElement("span", null, t("overview.jump")), React.createElement("span", { "aria-hidden": "true" }, "→")),
      React.createElement("p", { className: cls("caption-line") }, t("overview.caption")));
  }
  function Details({ snapshot, t }) {
    const group = (title, data, liability, totalLabel) => React.createElement("section", { key: title, className: cls("group", liability && "debt") },
      React.createElement("div", { className: cls("group-head") }, React.createElement("b", null, title), React.createElement("small", null, t("group.count", { count: data.accounts.length }))),
      data.accounts.map((account) => React.createElement(AccountRow, { key: account.account, account, liability, t })),
      React.createElement("p", { className: cls("group-total") },
        React.createElement("span", null, totalLabel),
        React.createElement("span", { className: cls("account-values") }, data.totals.map((amount, index) => React.createElement(Amount, { key: `${amount.commodity}-${index}`, amount, liability, t })))));
    return React.createElement(React.Fragment, null,
      group(t("group.assets"), snapshot.assets, false, t("total.assets")),
      group(t("group.liabilities"), snapshot.liabilities, true, t("total.liabilities")));
  }
  function LoadingBody({ t }) {
    const widths = ["85%", "50%", "100%", "100%", "70%", "100%", "90%"];
    return React.createElement("div", { role: "status" },
      React.createElement("div", { className: cls("loading-note") }, t("loading.note")),
      widths.map((width, index) => React.createElement("div", { key: index, className: cls("skeleton"), style: { width, height: index === 1 ? "34px" : "16px" } })));
  }
  function StateBody({ icon, title, description, action, alert = false, onAction }) {
    return React.createElement("div", { className: cls("state-message") },
      React.createElement("div", { className: cls("state-icon"), "aria-hidden": "true" }, icon),
      React.createElement("h4", null, title),
      React.createElement("div", alert ? { role: "alert" } : undefined, description),
      React.createElement("button", { type: "button", className: cls("state-action"), onClick: onAction }, action));
  }
  function TabBar({ tab, onSelect, t }) {
    const labels = { overview: t("tab.overview"), details: t("tab.details") };
    const select = (next) => { onSelect(next); document.getElementById(`${TAB_PREFIX}-${next}`)?.focus(); };
    const onKeyDown = (event) => { const index = TABS.findIndex(([id]) => id === tab); let next = -1; if (event.key === "ArrowRight") next = (index + 1) % TABS.length; else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length; else if (event.key === "Home") next = 0; else if (event.key === "End") next = TABS.length - 1; if (next >= 0) { event.preventDefault(); select(TABS[next][0]); } };
    return React.createElement("div", { className: cls("tabs"), role: "tablist", "aria-label": t("tabs.label") }, TABS.map(([id]) => React.createElement("button", { key: id, type: "button", id: `${TAB_PREFIX}-${id}`, role: "tab", className: cls("tab"), "aria-selected": tab === id, "aria-controls": PANEL_ID, tabIndex: tab === id ? 0 : -1, onClick: () => onSelect(id), onKeyDown }, labels[id])));
  }
  function Banner({ state, onRetry, t }) {
    // 探测失败与余额失败同样视为刷新失败：保留快照并给出可重试告警，仅重新请求期间显示“获取最新数据”。
    const failed = state.error ?? state.probeError;
    const message = failed
      ? (state.refreshedAt ? t("banner.failedWithTime", { time: fmtClock(state.refreshedAt) }) : t("banner.failedNoTime"))
      : t("banner.pending");
    return React.createElement("div", { className: cls("banner") },
      React.createElement("p", { role: failed ? "alert" : "status" }, message),
      React.createElement("button", { type: "button", className: cls("banner-retry"), onClick: onRetry }, t("action.retry")));
  }
  function bodyFor({ state, tab, onDetails, onRetry, onReread, t }) {
    const snapshot = state.snapshot;
    if (snapshot) {
      const empty = !snapshot.assets.accounts.length && !snapshot.liabilities.accounts.length;
      if (empty) return StateBody({ icon: "○", title: t("empty.title"), description: t("empty.description"), action: t("action.refresh"), onAction: onRetry });
      return tab === "overview" ? Overview({ snapshot, onDetails, t }) : Details({ snapshot, t });
    }
    if (state.loading) return LoadingBody({ t });
    if (state.probeError || state.error) {
      return StateBody({ icon: "!", title: t("error.title"), description: state.probeError ?? state.error ?? t("error.fallback"), action: t("action.reread"), alert: true, onAction: onReread });
    }
    return LoadingBody({ t });
  }
  function statusFor({ state, snapshot, empty, t }) {
    if (state.loading) return snapshot ? t("status.refreshing") : t("status.waitingLedger");
    if (empty || (!snapshot && (state.error || state.probeError))) return t("status.waitingBalance");
    return t("status.autoRefresh");
  }
  function freshLabel({ state, snapshot, t }) {
    if (!snapshot) return "—";
    if (state.stale) return state.refreshedAt ? t("status.lastSuccess", { time: fmtClock(state.refreshedAt) }) : "—";
    return state.refreshedAt ? t("status.updatedAt", { time: fmtClock(state.refreshedAt) }) : "—";
  }
  /* 桌面：非模态抽屉，Escape 仅在焦点位于抽屉内部且未被上层浮层处理时关闭；
   * 移动端：模态对话框，背景由遮罩隔离交互；打开或切入时焦点移入抽屉，Tab 循环，关闭后恢复原焦点。
   * onReload 为统一刷新入口：探测失败走重新探测，否则刷新余额。 */
  function Drawer({ state, tab, onTab, compact, drawerRef, onClose, onReload, onReread, t }) {
    const snapshot = state.snapshot;
    const empty = Boolean(snapshot && !snapshot.assets.accounts.length && !snapshot.liabilities.accounts.length);
    const onKeyDown = (event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } };
    return React.createElement(React.Fragment, null,
      compact ? React.createElement("div", { className: cls("backdrop"), onClick: onClose, "aria-hidden": "true" }) : null,
      React.createElement("aside", {
        id: DRAWER_ID, ref: drawerRef, tabIndex: -1, className: cls("drawer"), onKeyDown,
        ...(compact ? { role: "dialog", "aria-modal": "true", "aria-label": t("drawer.label") } : { "aria-label": t("drawer.label") }),
      },
        React.createElement("header", { className: cls("toolbar") },
          React.createElement("div", { className: cls("title") }, React.createElement("h2", { id: TITLE_ID }, t("drawer.title")), snapshot ? React.createElement("small", { className: cls("subtitle") }, t("drawer.asOf", { date: fmtAsOf(snapshot.asOf) })) : null),
          React.createElement(Icon, { kind: "refresh", label: t("drawer.refresh"), onClick: onReload, disabled: state.loading }),
          React.createElement(Icon, { kind: "close", label: t("drawer.close"), onClick: onClose })),
        React.createElement("div", { className: cls("tab-wrap") }, React.createElement(TabBar, { tab, onSelect: onTab, t })),
        snapshot && state.stale ? React.createElement(Banner, { state, onRetry: onReload, t }) : null,
        React.createElement("div", { id: PANEL_ID, role: "tabpanel", className: cls("content"), "aria-labelledby": `${TAB_PREFIX}-${tab}` },
          bodyFor({ state, tab, onDetails: () => { onTab("details"); document.getElementById(`${TAB_PREFIX}-details`)?.focus(); }, onRetry: onReload, onReread, t })),
        React.createElement("footer", { className: cls("footer") },
          React.createElement("span", null, React.createElement("i", { className: cls("dot"), "aria-hidden": "true" }), statusFor({ state, snapshot, empty, t })),
          React.createElement("span", null, freshLabel({ state, snapshot, t })))));
  }
  /* 移动端模态焦点循环；焦点停在抽屉根节点或仍在外部（打开瞬间、遮罩外的背景）时，Tab 直接落到循环边界，
   * 无可聚焦控件时聚焦抽屉本身。桌面不安装全局键盘处理，背景（对话）保持可操作。 */
  function cycleTabFocus(event, root) {
    const nodes = [...root.querySelectorAll('button:not([disabled]):not([tabindex="-1"]),[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])')];
    const active = document.activeElement;
    if (!nodes.length) { event.preventDefault(); root.focus(); return; }
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (active === root || !active || !root.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); return; }
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  }
  function useCompactMode() {
    return React.useSyncExternalStore(
      (callback) => { if (typeof window.matchMedia !== "function") return () => undefined; const query = window.matchMedia(COMPACT_QUERY); query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); },
      () => (typeof window.matchMedia === "function" ? window.matchMedia(COMPACT_QUERY).matches : false));
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

  /* ═══ DSH 接入：RPC 适配、controller、slot 注册与生命周期 ═══ */
  let lastTrigger; let pendingFocus = false; let outsideFocus;
  // 关闭恢复：优先恢复仍连接文档的有效触发入口，否则恢复记录的外部原焦点。
  const focusTrigger = () => {
    const trigger = lastTrigger; lastTrigger = undefined;
    const previous = outsideFocus; outsideFocus = undefined;
    if (trigger?.isConnected) { trigger.focus?.(); return; }
    if (previous?.isConnected) previous.focus?.();
  };
  const callError = (error) => new runtime.BalanceClientError(error?.code ?? "balance_unavailable", error?.message ?? "暂时无法读取账户余额，请重试。");
  const INJECT = ["sessions", "slots", "connection", "locale"];

  function apply(ctx) {
    installStyle();
    ctx.effect(() => removeStyle, `${NS}.style()`);
    const controller = new runtime.BalanceController({
      rpc: {
        capability: async (sessionId, signal) => { const outer = await ctx.connection.rpc.call("/dsh-moneypal", "capability", { sessionId }, signal); if (!outer?.ok) throw callError(); const inner = outer.value; if (!inner?.ok) throw callError(inner?.error); return Boolean(inner.value?.candidate); },
        balances: async (sessionId, asOf, signal) => { const outer = await ctx.connection.rpc.call("/dsh-moneypal", "balances", { sessionId, asOf }, signal); if (!outer?.ok) throw callError(); const inner = outer.value; if (!inner?.ok) throw callError(inner?.error); return inner.value; },
      },
      storage: window.localStorage, visible: () => document.visibilityState === "visible",
    });
    ctx.effect(() => () => controller.dispose(), `${NS}.controller()`);
    const face = setupLocale(ctx);
    ctx.effect(() => face.dispose, `${NS}.locale()`);

    function useBalanceState() { return React.useSyncExternalStore((listener) => controller.subscribe(listener), () => controller.state); }
    // 两个挂载点都订阅 locale 快照：宿主切换语言时触发重渲染，face.t 实时翻译函数随之输出新文案。
    function useLocale() { React.useSyncExternalStore(face.subscribe, face.getSnapshot); return face.t; }

    function HeaderSlot(sessionProps) {
      const state = useBalanceState();
      const t = useLocale();
      React.useEffect(() => { void controller.setSession(sessionProps.sessionId); }, [sessionProps.sessionId]);
      if (!sessionProps.sessionId || state.sessionId !== sessionProps.sessionId || state.capability !== "candidate") return null;
      return Entry({ open: state.open, t, onActivate: (event) => { lastTrigger = event.currentTarget; pendingFocus = true; void controller.toggle(true); } });
    }

    function DrawerSlot(globalProps) {
      const state = useBalanceState();
      const t = useLocale();
      const compact = useCompactMode();
      const drawerRef = React.useRef(null);
      const [tab, setTab] = React.useState("overview");
      const sessionId = globalProps.useSessions((sessions) => sessions.current);
      React.useEffect(() => { void controller.setSession(sessionId); }, [sessionId]);
      React.useEffect(() => { setTab("overview"); }, [state.open, state.sessionId]);
      React.useEffect(() => { const onVisibility = () => controller.visibleChanged(); document.addEventListener("visibilitychange", onVisibility); return () => document.removeEventListener("visibilitychange", onVisibility); }, []);
      React.useEffect(() => {
        if (!state.open) return undefined;
        // 自动恢复的打开状态不抢焦点；用户主动打开（入口激活）才聚焦抽屉。
        // 移动端（含桌面切入窄屏）为模态：焦点仍在外部时移入抽屉并记录原焦点，关闭时经 focusTrigger 恢复。
        if (pendingFocus) { pendingFocus = false; drawerRef.current?.focus(); }
        else if (compact) {
          const active = document.activeElement;
          if (!active || !drawerRef.current?.contains(active)) { outsideFocus = active ?? undefined; drawerRef.current?.focus(); }
        }
        if (!compact) return undefined;
        const onKey = (event) => { if (event.key === "Tab" && drawerRef.current) cycleTabFocus(event, drawerRef.current); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [state.open, compact]);
      if (!state.open) return null;
      const close = () => { setTab("overview"); void controller.toggle(false).then(focusTrigger); };
      // 统一刷新入口：探测失败时刷新按钮走重新探测，否则走余额刷新。
      const reload = () => { void (state.probeError ? controller.retry() : controller.refresh()); };
      return React.createElement(Drawer, {
        state, tab, compact, drawerRef, t,
        onTab: setTab,
        onClose: close,
        onReload: reload,
        onReread: () => void controller.retry(),
      });
    }

    ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({ name: "conversation.session.header.actions", id: "dsh-moneypal-balance", order: 20, inject: (sessionId) => ({ sessionId }) }, HeaderSlot));
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "dsh-moneypal-balance-drawer", order: 20 }, DrawerSlot));
  }

  module.exports.apply = apply; module.exports.inject = INJECT; return module.exports;
}});
