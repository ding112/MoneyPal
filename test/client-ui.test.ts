import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

/* 余额抽屉 UI 行为测试：在 node:vm 中执行编译后的 DSH lazy CommonJS bundle，
 * 用最小假 React（元素树 + 按组件 fiber 的 hooks + deps/cleanup 语义 + 外部 store 订阅通知与卸载清理）
 * 驱动真实组件与 BalanceController，覆盖模态语义、焦点规则、locale 文案与余额内容渲染。 */

type Element = { type: unknown; props: Record<string, unknown> };
type SlotComponent = (props: Record<string, unknown>) => unknown;
type ReactLike = { Fragment: unknown; createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => Element };
type KeyEvent = { key: string; defaultPrevented: boolean; preventDefault: () => void };
type Mount = { component: SlotComponent; props: Record<string, unknown>; output: unknown };

function createReact() {
  const pendingEffects: Array<() => unknown> = [];
  const FRAGMENT = Symbol("fragment");
  const owners: unknown[] = [];
  const fibers = new Map<unknown, { cells: Array<Record<string, unknown>>; cursor: number }>();
  const mounts = new Map<SlotComponent, Mount>();
  const dirty = new Set<Mount>();
  let rendering = false;
  let current: Mount | undefined;

  function fiber(): { cells: Array<Record<string, unknown>>; cursor: number } {
    const owner = owners[owners.length - 1];
    let value = fibers.get(owner);
    if (!value) { value = { cells: [], cursor: 0 }; fibers.set(owner, value); }
    return value;
  }
  const react: ReactLike = {
    Fragment: FRAGMENT,
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element {
      const normalized = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
      return { type, props: { ...(props ?? {}), children: normalized } };
    },
  };
  const hooks = {
    useEffect(effect: () => unknown, deps?: unknown[]) {
      const state = fiber(); const index = state.cursor++;
      if (state.cells.length <= index) state.cells.push({});
      const cell = state.cells[index]!;
      const previous = cell.deps as unknown[] | undefined;
      const changed = !previous || !deps || deps.length !== previous.length || deps.some((dep, position) => !Object.is(dep, previous[position]));
      if (!changed) return;
      cell.deps = deps ? [...deps] : undefined;
      // 清理函数在执行时才读取：同一 cell 在两次 runEffects 之间多次重渲染时仍能正确串联 cleanup。
      pendingEffects.push(() => {
        const previousCleanup = cell.cleanup as (() => void) | undefined;
        cell.cleanup = undefined;
        if (previousCleanup) previousCleanup();
        cell.cleanup = effect();
      });
    },
    useState(init: unknown) {
      const state = fiber(); const index = state.cursor++;
      if (state.cells.length <= index) state.cells.push({ value: typeof init === "function" ? (init as () => unknown)() : init });
      const cell = state.cells[index]!;
      return [cell.value, (next: unknown) => { cell.value = typeof next === "function" ? (next as (previous: unknown) => unknown)(cell.value) : next; }];
    },
    useRef(init: unknown) {
      const state = fiber(); const index = state.cursor++;
      if (state.cells.length <= index) state.cells.push({ current: init });
      return state.cells[index];
    },
    useSyncExternalStore(subscribe: (notify: () => void) => () => void, getSnapshot: () => unknown) {
      const state = fiber(); const index = state.cursor++;
      if (state.cells.length <= index) state.cells.push({});
      const cell = state.cells[index]!;
      const value = getSnapshot();
      cell.snapshot = value;
      if (cell.subscribed !== subscribe) {
        (cell.unsubscribe as (() => void) | undefined)?.();
        const mount = current!;
        cell.unsubscribe = subscribe(() => {
          const next = getSnapshot();
          if (Object.is(next, cell.snapshot)) return;
          cell.snapshot = next;
          scheduleUpdate(mount);
        });
        cell.subscribed = subscribe;
      }
      return value;
    },
  };

  /** store 通知驱动的重渲染：渲染期间改为微任务，避免重入；其余立即执行，通知即见效。 */
  function scheduleUpdate(mount: Mount) {
    dirty.add(mount);
    if (rendering) { queueMicrotask(flush); return; }
    flush();
  }
  function flush() {
    for (const mount of [...dirty]) {
      dirty.delete(mount);
      if (mounts.get(mount.component) !== mount) continue;
      invokeComponent(mount.component, mount.props);
    }
  }

  function renderNode(node: unknown): unknown {
    if (node === null || node === undefined || typeof node === "boolean") return node;
    if (Array.isArray(node)) return node.map((child) => renderNode(child));
    if (typeof node !== "object") return node;
    const element = node as Element;
    if (element.type === FRAGMENT) {
      const children = element.props.children;
      return Array.isArray(children) ? children.map((child) => renderNode(child)) : renderNode(children);
    }
    if (typeof element.type === "function") {
      return invokeComponent(element.type as SlotComponent, element.props);
    }
    const children = element.props.children;
    const rendered = children === undefined ? undefined
      : Array.isArray(children) ? children.map((child) => renderNode(child))
      : children !== null && typeof children === "object" ? renderNode(children)
      : children;
    return { type: element.type, props: { ...element.props, children: rendered } };
  }

  /** 以组件为 fiber 边界调用：hooks 状态按组件隔离，cursor 每次渲染归零（deps/cleanup 语义依赖于此）。 */
  function invokeComponent(component: SlotComponent, props: Record<string, unknown>): unknown {
    let mount = mounts.get(component);
    if (!mount) { mount = { component, props, output: undefined }; mounts.set(component, mount); }
    mount.props = props;
    const previousCurrent = current;
    const previousRendering = rendering;
    current = mount;
    rendering = true;
    owners.push(component);
    const fiberState = fibers.get(component);
    if (fiberState) fiberState.cursor = 0;
    try {
      mount.output = renderNode(component(props));
      return mount.output;
    } finally {
      owners.pop();
      current = previousCurrent;
      rendering = previousRendering;
    }
  }

  return {
    react, hooks,
    render: (node: unknown) => renderNode(node),
    invoke: (component: SlotComponent, props: Record<string, unknown>) => invokeComponent(component, props),
    runEffects: () => { for (const effect of pendingEffects.splice(0)) effect(); },
    outputOf: (component: SlotComponent) => mounts.get(component)?.output,
    unmount: (component: SlotComponent) => {
      const mount = mounts.get(component);
      if (!mount) return;
      const fiberState = fibers.get(component);
      for (const cell of fiberState?.cells ?? []) {
        (cell.cleanup as (() => void) | undefined)?.();
        (cell.unsubscribe as (() => void) | undefined)?.();
        cell.cleanup = undefined;
        cell.unsubscribe = undefined;
      }
      fibers.delete(component);
      mounts.delete(component);
      dirty.delete(mount);
    },
  };
}

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && "props" in node && "type" in node;
}

function flattenTree(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) { for (const child of node) flattenTree(child, out); return out; }
  out.push(node);
  if (isElement(node)) {
    const children = node.props.children;
    if (Array.isArray(children)) for (const child of children) flattenTree(child, out);
    else if (children !== undefined && children !== null && typeof children === "object") flattenTree(children, out);
  }
  return out;
}

function findAll(tree: unknown, predicate: (element: Element) => boolean): Element[] { return flattenTree(tree).filter(isElement).filter(predicate); }
function findOne(tree: unknown, predicate: (element: Element) => boolean, message: string): Element {
  const found = findAll(tree, predicate);
  assert.equal(found.length, 1, message);
  return found[0]!;
}
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (!isElement(node)) return String(node);
  return textOf(node.props.children);
}
const classNameOf = (element: Element): string => String(element.props.className ?? "");
const hasClass = (element: Element, name: string) => classNameOf(element).split(" ").includes(`dsh-moneypal-balance-${name}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function createDocument() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const document = {
    visibilityState: "visible",
    activeElement: null as unknown,
    head: {
      children: [] as Array<{ id: string; remove: () => void; textContent: string }>,
      append(child: { id: string; remove: () => void; textContent: string }) { this.children.push(child); },
    },
    getElementById(id: string) { return this.head.children.find((child) => child.id === id) ?? null; },
    createElement(tag: string) {
      const node = { tag, id: "", textContent: "", remove: () => {
        const index = document.head.children.indexOf(node);
        if (index >= 0) document.head.children.splice(index, 1);
      } };
      return node;
    },
    addEventListener(type: string, handler: (event: unknown) => void) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type))!.add(handler); },
    removeEventListener(type: string, handler: (event: unknown) => void) { listeners.get(type)?.delete(handler); },
  };
  return { document, listenersOfType: (type: string) => [...listeners.get(type) ?? []] };
}

/** 假宿主 locale：register/bind/subscribe/getLocale 与 DSH LocaleRuntime 对齐，setLocale 供测试切换语言。 */
function createLocale() {
  const dictionaries = new Map<string, Record<string, Record<string, string>>>();
  const listeners = new Set<() => void>();
  const stats = { subscribed: 0, disposed: 0 };
  let snapshot = { active: "zh" as "zh" | "en", locales: ["zh", "en"], revision: 0 };
  return {
    stats,
    register: (namespace: string, pair: Record<string, Record<string, string>>) => { dictionaries.set(namespace, pair); return () => dictionaries.delete(namespace); },
    bind: (namespace: string) => (key: string, params?: Record<string, unknown>) => {
      const pair = dictionaries.get(namespace);
      const text = pair?.[snapshot.active]?.[key] ?? pair?.zh?.[key] ?? key;
      return text.replace(/\{(\w+)\}/gu, (whole: string, name: string) => String(params?.[name] ?? whole));
    },
    subscribe: (listener: () => void) => { stats.subscribed += 1; listeners.add(listener); return () => { stats.disposed += 1; listeners.delete(listener); }; },
    getLocale: () => snapshot,
    setLocale: (active: "zh" | "en") => { snapshot = { active, locales: [active], revision: snapshot.revision + 1 }; for (const listener of [...listeners]) listener(); },
  };
}

const EMPTY_SNAPSHOT = { asOf: "2026-09-05", assets: { accounts: [] as unknown[], totals: [] as unknown[] }, liabilities: { accounts: [] as unknown[], totals: [] as unknown[] } };
function fixtureSnapshot(): Record<string, unknown> {
  const savings = Array.from({ length: 50 }, (_, index) => ({ account: `Assets:C-储蓄${String(index + 1).padStart(2, "0")}`, amounts: [{ commodity: "CNY", quantity: "100.00" }] }));
  return {
    asOf: "2026-09-05",
    assets: {
      accounts: [
        { account: "Assets:C-现金", amounts: [{ commodity: "CNY", quantity: "12345678901234567.89" }, { commodity: "USD", quantity: "0.30" }] },
        { account: "Assets:C-证券", amounts: [{ commodity: "CNY", quantity: "-500.00" }] },
        ...savings,
      ],
      totals: [{ commodity: "CNY", quantity: "12345678901239067.89" }, { commodity: "USD", quantity: "0.30" }],
    },
    liabilities: {
      accounts: [
        { account: "Liabilities:C-信用卡", amounts: [{ commodity: "CNY", quantity: "-1200.00" }] },
        { account: "Liabilities:C-花呗", amounts: [{ commodity: "CNY", quantity: "50.00" }] },
      ],
      totals: [{ commodity: "CNY", quantity: "-1150.00" }],
    },
  };
}

/** 内容可区分的快照变体，用于断言“确实读取了新余额”。 */
function variantSnapshot(marker: string): Record<string, unknown> {
  const snapshot = fixtureSnapshot() as Record<string, unknown> & { assets: { accounts: Array<{ account: string }> } };
  snapshot.assets.accounts[0].account = `Assets:C-现金·${marker}`;
  return snapshot;
}

interface Harness {
  react: ReturnType<typeof createReact>;
  document: ReturnType<typeof createDocument>["document"];
  listenersOfType: (type: string) => Array<(event: unknown) => void>;
  effects: Array<{ name: string; dispose: () => void }>;
  head: Array<{ id: string; remove: () => void; textContent: string }>;
  header: SlotComponent;
  drawer: SlotComponent;
  locale: ReturnType<typeof createLocale>;
  rpc: { capabilityOk: boolean; balances: unknown; balancesError?: { code: string; message: string }; calls: string[] };
  setCompact(matches: boolean): void;
}

async function harness(options: { storedOpen?: string; balances?: unknown } = {}): Promise<Harness> {
  const source = await readFile(new URL("../../dist/src/client.bundle.cjs", import.meta.url), "utf8");
  const reactEnv = createReact();
  const doc = createDocument();
  let registration: { factory: (require: (name: string) => unknown) => { apply: (context: unknown) => void; inject: string[] } } | undefined;
  let compactMatches = false;
  const window = {
    __ModuleLoader__: { load: (value: typeof registration) => { registration = value; } },
    localStorage: { getItem: () => options.storedOpen ?? null, setItem: () => undefined },
    matchMedia: (query: string) => ({ matches: query === "(max-width: 767px)" ? compactMatches : false, addEventListener: () => undefined, removeEventListener: () => undefined }),
  };
  runInNewContext(source, { window, document: doc.document, AbortController, setTimeout: () => 0, clearTimeout: () => undefined });
  const captured = new Map<string, SlotComponent>();
  const effects: Array<{ name: string; dispose: () => void }> = [];
  const locale = createLocale();
  // RPC 可变桩：capabilityOk 控制探测成败，balances/balancesError 控制余额请求结果，calls 记录调用序列。
  const rpc: Harness["rpc"] = { capabilityOk: true, balances: options.balances, calls: [] };
  registration!.factory((name) => name === "react" ? { ...reactEnv.react, ...reactEnv.hooks } : undefined).apply({
    connection: { rpc: { call: async (_channel: string, endpoint: string, payload: { sessionId: string }) => {
      rpc.calls.push(endpoint);
      if (endpoint === "capability") {
        if (!rpc.capabilityOk || payload.sessionId !== "ledger") return { ok: true, value: { ok: false, error: { code: "probe_unavailable", message: "暂时无法连接账本" } } };
        return { ok: true, value: { ok: true, value: { candidate: true } } };
      }
      if (rpc.balancesError) return { ok: true, value: { ok: false, error: rpc.balancesError } };
      const value = typeof rpc.balances === "function" ? (rpc.balances as () => unknown)() : rpc.balances ?? fixtureSnapshot();
      return { ok: true, value: { ok: true, value } };
    } } },
    slots: { inject: (_name: string, callback: () => unknown) => callback(), register: (definition: { id?: string }, value: SlotComponent) => { if (definition.id) captured.set(definition.id, value); } },
    effect: (callback: () => () => void, name?: string) => { const dispose = callback(); effects.push({ name: name ?? "", dispose }); return dispose; },
    locale,
  });
  const header = captured.get("dsh-moneypal-balance");
  const drawer = captured.get("dsh-moneypal-balance-drawer");
  assert.ok(header && drawer, "slot 组件未注册");
  return {
    react: reactEnv, document: doc.document, listenersOfType: doc.listenersOfType, effects, head: doc.document.head.children,
    header, drawer, locale, rpc, setCompact: (matches: boolean) => { compactMatches = matches; },
  };
}

function renderSlot(h: Harness, component: SlotComponent, props: Record<string, unknown>): unknown {
  return h.react.invoke(component, props);
}

const useSessionsFor = (sessionId: string | undefined) => (selector: (state: { current: string | undefined }) => unknown) => selector({ current: sessionId });
const clickEntry = (entry: Element, currentTarget: unknown = { isConnected: true, focus: () => undefined }) => (entry.props.onClick as (event: { currentTarget: unknown }) => void)({ currentTarget });
const fireVisibility = (h: Harness) => { for (const handler of h.listenersOfType("visibilitychange")) (handler as () => void)(); };

/** 模拟抽屉根节点：focus/contains/querySelectorAll 对齐 DOM 语义，供焦点断言使用。 */
function mockDrawerRoot(nodes: unknown[] = []) {
  const root = {
    focusCalls: 0,
    focus() { root.focusCalls += 1; },
    contains(node: unknown) { return node === root || nodes.includes(node); },
    querySelectorAll: () => nodes,
  };
  return root;
}

/** 打开抽屉直到快照就绪，返回抽屉渲染树。 */
async function openDrawer(h: Harness, options: { balances?: unknown } = {}): Promise<unknown> {
  renderSlot(h, h.header, { sessionId: "ledger" });
  h.react.runEffects(); await tick();
  const entry = renderSlot(h, h.header, { sessionId: "ledger" }) as Element;
  assert.equal(entry.type, "button", "入口未渲染");
  clickEntry(entry);
  h.react.runEffects(); await tick();
  return renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
}

test("bundle 注入 locale 服务并注册命名空间文案，入口携带展开状态与目标关联", async () => {
  const h = await harness();
  assert.ok(h.head.some((style) => style.id === "dsh-moneypal-balance-style" && style.textContent.includes("--dsh-moneypal-balance-surface")), "apply 未安装命名空间样式");
  assert.deepEqual(h.effects.map((effect) => effect.name).sort(), ["dsh-moneypal-balance.controller()", "dsh-moneypal-balance.locale()", "dsh-moneypal-balance.style()"], "生命周期 disposer 名称不符合约定");
  renderSlot(h, h.header, { sessionId: "ledger" });
  h.react.runEffects(); await tick();
  const entry = renderSlot(h, h.header, { sessionId: "ledger" }) as Element;
  assert.equal(entry.type, "button");
  assert.equal(entry.props["aria-label"], "查看账户余额");
  assert.equal(entry.props["aria-expanded"], false, "入口初始应为收起状态");
  assert.equal(entry.props["aria-controls"], "dsh-moneypal-balance-drawer");
  await openDrawer(h);
  const opened = renderSlot(h, h.header, { sessionId: "ledger" }) as Element;
  assert.equal(opened.props["aria-expanded"], true, "抽屉打开后入口应为展开状态");
});

test("桌面为非模态抽屉：无 dialog 语义、无遮罩、无全局键盘监听，Escape 仅在抽屉持有焦点且未被处理时关闭", async () => {
  const h = await harness();
  await openDrawer(h);
  const tree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  const aside = findOne(tree, (element) => element.type === "aside", "桌面抽屉未渲染");
  assert.equal(aside.props.role, undefined, "桌面不得声明 dialog 角色");
  assert.equal(aside.props["aria-modal"], undefined, "桌面不得声明模态");
  assert.equal(findAll(tree, (element) => classNameOf(element).includes("backdrop")).length, 0, "桌面不应渲染背景遮罩");
  assert.equal(h.listenersOfType("keydown").length, 0, "桌面不得安装全局键盘监听");

  const focusSpy = { calls: 0 };
  const entry = renderSlot(h, h.header, { sessionId: "ledger" }) as Element;
  (entry.props.onClick as (event: { currentTarget: unknown }) => void)({ currentTarget: { isConnected: true, focus: () => { focusSpy.calls += 1; } } });
  await tick(); h.react.runEffects();

  const upperHandled: KeyEvent = { key: "Escape", defaultPrevented: true, preventDefault: () => undefined };
  (aside.props.onKeyDown as (event: KeyEvent) => void)(upperHandled);
  await tick();
  const stillOpen = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  assert.equal(findAll(stillOpen, (element) => element.type === "aside").length, 1, "上层浮层已处理 Escape 时抽屉不得关闭");

  const event: KeyEvent = { key: "Escape", defaultPrevented: false, preventDefault: () => undefined };
  (aside.props.onKeyDown as (event: KeyEvent) => void)(event);
  await tick();
  assert.equal(focusSpy.calls, 1, "关闭后焦点应恢复到入口");
});

test("移动端为模态抽屉：dialog 语义、背景遮罩隔离、Tab 焦点循环且关闭时移除监听", async () => {
  const h = await harness();
  h.setCompact(true);
  await openDrawer(h);
  const tree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  const aside = findOne(tree, (element) => element.type === "aside", "移动端抽屉未渲染");
  assert.equal(aside.props.role, "dialog");
  assert.equal(aside.props["aria-modal"], "true");
  const backdrop = findOne(tree, (element) => classNameOf(element).includes("backdrop"), "移动端未渲染背景遮罩");
  // 在 effect 执行前绑定模拟抽屉根节点，避免事后设置 ref 掩盖焦点逻辑问题
  const focusCalls = { first: 0, last: 0 };
  const first = { focus: () => { focusCalls.first += 1; } };
  const last = { focus: () => { focusCalls.last += 1; } };
  (aside.props.ref as { current: unknown }).current = mockDrawerRoot([first, {}, last]);
  h.react.runEffects();
  const handlers = h.listenersOfType("keydown");
  assert.equal(handlers.length, 1, "移动端应安装一个 Tab 焦点循环监听");

  const document = h.document as unknown as { activeElement: unknown };
  const handler = handlers[0]!;
  document.activeElement = last;
  const prevent = { calls: 0 };
  handler({ key: "Tab", shiftKey: false, preventDefault: () => { prevent.calls += 1; } });
  assert.equal(prevent.calls, 1, "从最后一个控件继续 Tab 应循环回第一个");
  assert.equal(focusCalls.first, 1);
  document.activeElement = first;
  handler({ key: "Tab", shiftKey: true, preventDefault: () => undefined });
  assert.equal(focusCalls.last, 1, "反向 Tab 从第一个控件应循环到最后一个");

  (backdrop.props.onClick as () => void)();
  await tick(); h.react.runEffects();
  const closed = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.equal(findAll(closed, (element) => element.type === "aside").length, 0, "点击遮罩应关闭抽屉");
  assert.equal(h.listenersOfType("keydown").length, 0, "关闭后应移除全局键盘监听");
});

test("自动恢复打开不抢焦点，用户主动打开才聚焦抽屉", async () => {
  const h = await harness({ storedOpen: "true" });
  renderSlot(h, h.header, { sessionId: "ledger" });
  h.react.runEffects(); await tick();
  const tree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  const aside = findOne(tree, (element) => element.type === "aside", "恢复的抽屉未渲染");
  const focusSpy = { calls: 0 };
  (aside.props.ref as { current: unknown }).current = { focus: () => { focusSpy.calls += 1; } };
  assert.equal(focusSpy.calls, 0, "自动恢复不得抢走对话焦点");

  (aside.props.onKeyDown as (event: KeyEvent) => void)({ key: "Escape", defaultPrevented: false, preventDefault: () => undefined });
  await tick();
  renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  const entry = renderSlot(h, h.header, { sessionId: "ledger" }) as Element;
  clickEntry(entry);
  await tick();
  renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.equal(focusSpy.calls, 1, "用户主动打开应聚焦抽屉");
});

test("探测失败后统一重试入口：告警横幅、重新探测恢复新数据、持续失败保留快照", async () => {
  const h = await harness();
  await openDrawer(h);
  h.react.runEffects(); await tick();
  const fresh = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.equal(findAll(fresh, (element) => hasClass(element, "banner")).length, 0, "正常状态不应显示横幅");

  // 探测与余额同时失败（后端不可用）：保留旧快照，横幅转为失败告警
  h.rpc.capabilityOk = false;
  h.rpc.balancesError = { code: "balances_unavailable", message: "读取余额失败" };
  fireVisibility(h);
  await tick(); h.react.runEffects();
  const staleTree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.ok(textOf(staleTree).includes("C-现金"), "探测失败应保留旧快照");
  const banner = findOne(staleTree, (element) => hasClass(element, "banner"), "探测失败后未显示过期横幅");
  const message = findOne(banner, (element) => element.type === "p", "横幅缺少消息");
  assert.equal(message.props.role, "alert", "探测失败提示应为 alert");
  assert.ok(textOf(banner).includes("刷新失败"), `横幅应显示失败提示：${textOf(banner)}`);

  // 点击重试应重新探测（能力未知时刷新是 no-op，能读到新数据即证明走了探测路径）
  h.rpc.capabilityOk = true;
  h.rpc.balancesError = undefined;
  h.rpc.balances = variantSnapshot("重试恢复");
  (findOne(banner, (element) => hasClass(element, "banner-retry"), "横幅缺少重试按钮").props.onClick as () => void)();
  await tick(); h.react.runEffects();
  const recovered = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.equal(findAll(recovered, (element) => hasClass(element, "banner")).length, 0, "重试成功后横幅应消失");
  assert.ok(textOf(recovered).includes("C-现金·重试恢复"), "重试成功后应读取新余额");

  // 持续失败（重试后仍失败）：保留旧快照并保持失败提示
  h.rpc.capabilityOk = false;
  h.rpc.balancesError = { code: "balances_unavailable", message: "读取余额失败" };
  fireVisibility(h);
  await tick(); h.react.runEffects();
  const failedTree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.ok(textOf(failedTree).includes("C-现金·重试恢复"), "再次失败应保留旧快照");
  const failedBanner = findOne(failedTree, (element) => hasClass(element, "banner"), "失败后应显示横幅");
  (findOne(failedBanner, (element) => hasClass(element, "banner-retry"), "横幅缺少重试按钮").props.onClick as () => void)();
  await tick(); h.react.runEffects();
  const stillTree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  // 此时 error 已被 retry 清空，失败提示只能来自 probeError：验证横幅同时识别探测失败
  const stillBanner = findOne(stillTree, (element) => hasClass(element, "banner"), "仅探测失败也应显示横幅");
  const stillMessage = findOne(stillBanner, (element) => element.type === "p", "横幅缺少消息");
  assert.equal(stillMessage.props.role, "alert", "仅探测失败也应给出 alert");
  assert.ok(textOf(stillBanner).includes("刷新失败"), "横幅应识别探测失败");
  assert.ok(textOf(stillTree).includes("C-现金·重试恢复"), "重试仍失败应保留旧快照");
});

test("余额请求失败仍走余额刷新路径：横幅重试不触发重新探测", async () => {
  const h = await harness();
  await openDrawer(h);
  h.react.runEffects(); await tick();
  renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();

  // 普通余额请求失败（能力正常）：保留快照并告警
  h.rpc.balancesError = { code: "balances_unavailable", message: "读取余额失败" };
  fireVisibility(h);
  await tick(); h.react.runEffects();
  const failed = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.ok(textOf(failed).includes("C-现金"), "余额请求失败应保留旧快照");
  const banner = findOne(failed, (element) => hasClass(element, "banner"), "余额请求失败后未显示横幅");
  const message = findOne(banner, (element) => element.type === "p", "横幅缺少消息");
  assert.equal(message.props.role, "alert", "余额失败提示应为 alert");

  // 探测通路改为失败：若误走重试会引入探测失败状态；走刷新则直接恢复新数据
  h.rpc.capabilityOk = false;
  h.rpc.balancesError = undefined;
  h.rpc.balances = variantSnapshot("刷新恢复");
  (findOne(banner, (element) => hasClass(element, "banner-retry"), "横幅缺少重试按钮").props.onClick as () => void)();
  await tick(); h.react.runEffects();
  const recovered = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.equal(findAll(recovered, (element) => hasClass(element, "banner")).length, 0, "余额刷新恢复后横幅应消失");
  assert.ok(textOf(recovered).includes("C-现金·刷新恢复"), "余额刷新应读取新快照");
});

test("空账本且探测失败时空状态刷新按钮走重试路径", async () => {
  const h = await harness({ balances: EMPTY_SNAPSHOT });
  await openDrawer(h);
  h.react.runEffects(); await tick();
  const empty = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.ok(textOf(empty).includes("暂无账户余额"), "应先呈现空状态");

  h.rpc.capabilityOk = false;
  fireVisibility(h);
  await tick(); h.react.runEffects();
  const failed = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  const action = findOne(failed, (element) => hasClass(element, "state-action"), "空状态缺少刷新按钮");
  assert.equal(textOf(action), "刷新余额");

  // 能力未知时刷新是 no-op；按钮能恢复完整数据即证明走了重试探测路径
  h.rpc.capabilityOk = true;
  h.rpc.balances = undefined;
  (action.props.onClick as () => void)();
  await tick(); h.react.runEffects();
  const recovered = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.ok(textOf(recovered).includes("C-现金"), "空状态刷新应经重试恢复完整余额");
  assert.ok(!textOf(recovered).includes("暂无账户余额"), "恢复后不应仍是空状态");
});

test("移动端自动恢复将外部焦点移入抽屉，关闭后恢复原焦点", async () => {
  const h = await harness({ storedOpen: "true" });
  h.setCompact(true);
  renderSlot(h, h.header, { sessionId: "ledger" });
  h.react.runEffects(); await tick();
  const composer = { isConnected: true, focusCalls: 0, focus() { composer.focusCalls += 1; } };
  h.document.activeElement = composer;
  const tree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  const aside = findOne(tree, (element) => element.type === "aside", "恢复的抽屉未渲染");
  const root = mockDrawerRoot();
  (aside.props.ref as { current: unknown }).current = root;
  h.react.runEffects();
  assert.equal(root.focusCalls, 1, "移动端自动恢复应把外部焦点移入抽屉");

  (aside.props.onKeyDown as (event: KeyEvent) => void)({ key: "Escape", defaultPrevented: false, preventDefault: () => undefined });
  await tick(); h.react.runEffects();
  assert.equal(composer.focusCalls, 1, "关闭后应恢复记录的外部原焦点");
  const closed = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  assert.equal(findAll(closed, (element) => element.type === "aside").length, 0, "Escape 应关闭抽屉");
});

test("桌面切窄屏将外部焦点移入抽屉，关闭优先恢复触发入口，退出移动端清理监听", async () => {
  const h = await harness();
  renderSlot(h, h.header, { sessionId: "ledger" });
  h.react.runEffects(); await tick();
  const entry = renderSlot(h, h.header, { sessionId: "ledger" }) as Element;
  const entryNode = { isConnected: true, focusCalls: 0, focus() { entryNode.focusCalls += 1; } };
  clickEntry(entry, entryNode);
  await tick();
  const desktopTree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  const desktopAside = findOne(desktopTree, (element) => element.type === "aside", "桌面抽屉未渲染");
  const desktopRoot = mockDrawerRoot();
  (desktopAside.props.ref as { current: unknown }).current = desktopRoot;
  h.react.runEffects();
  assert.equal(desktopRoot.focusCalls, 1, "入口激活应聚焦抽屉");

  // 用户把焦点移到对话输入框后窗口缩为窄屏：焦点移入并记录
  const composer = { isConnected: true, focusCalls: 0, focus() { composer.focusCalls += 1; } };
  h.document.activeElement = composer;
  h.setCompact(true);
  const narrowTree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  const narrowAside = findOne(narrowTree, (element) => element.type === "aside", "窄屏抽屉未渲染");
  const narrowRoot = mockDrawerRoot();
  (narrowAside.props.ref as { current: unknown }).current = narrowRoot;
  h.react.runEffects();
  assert.equal(narrowRoot.focusCalls, 1, "切入窄屏应把外部焦点移入抽屉");

  const closeButton = findOne(narrowTree, (element) => hasClass(element, "icon") && element.props["aria-label"] === "关闭账户余额", "关闭按钮缺失");
  (closeButton.props.onClick as () => void)();
  await tick(); h.react.runEffects();
  assert.equal(entryNode.focusCalls, 1, "关闭后应优先恢复有效触发入口");
  assert.equal(composer.focusCalls, 0, "存在有效触发入口时不得恢复外部焦点");
  const closed = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  assert.equal(findAll(closed, (element) => element.type === "aside").length, 0, "关闭按钮应关闭抽屉");

  // 移动端再次打开后退出窄屏：Tab 循环监听应清理
  const reopened = renderSlot(h, h.header, { sessionId: "ledger" }) as Element;
  clickEntry(reopened);
  await tick();
  const mobileTree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  const mobileAside = findOne(mobileTree, (element) => element.type === "aside", "移动端抽屉未渲染");
  (mobileAside.props.ref as { current: unknown }).current = mockDrawerRoot();
  h.react.runEffects();
  assert.equal(h.listenersOfType("keydown").length, 1, "移动端应安装 Tab 循环监听");
  h.setCompact(false);
  renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.equal(h.listenersOfType("keydown").length, 0, "退出移动端后应清理 Tab 循环监听");
});

test("移动端 Tab 从根节点或外部进入定位首末控件，无可聚焦控件时聚焦抽屉本身", async () => {
  const h = await harness({ storedOpen: "true" });
  h.setCompact(true);
  renderSlot(h, h.header, { sessionId: "ledger" });
  h.react.runEffects(); await tick();
  const tree = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  const aside = findOne(tree, (element) => element.type === "aside", "恢复的抽屉未渲染");
  const first = { focusCalls: 0, focus() { first.focusCalls += 1; } };
  const last = { focusCalls: 0, focus() { last.focusCalls += 1; } };
  const root = mockDrawerRoot([first, {}, last]);
  (aside.props.ref as { current: unknown }).current = root;
  h.react.runEffects();
  const handler = h.listenersOfType("keydown")[0]!;
  const document = h.document as unknown as { activeElement: unknown };

  // 自动恢复已把焦点移入抽屉根节点：正向 Tab 落到首个控件
  document.activeElement = root;
  handler({ key: "Tab", shiftKey: false, preventDefault: () => undefined });
  assert.equal(first.focusCalls, 1, "从根节点正向 Tab 应聚焦首个控件");

  // 焦点仍在外部：正向落首个、反向落末个
  document.activeElement = {};
  handler({ key: "Tab", shiftKey: false, preventDefault: () => undefined });
  assert.equal(first.focusCalls, 2, "从外部正向 Tab 应聚焦首个控件");
  document.activeElement = {};
  handler({ key: "Tab", shiftKey: true, preventDefault: () => undefined });
  assert.equal(last.focusCalls, 1, "从外部反向 Tab 应聚焦末个控件");

  // 无可聚焦控件：Tab 阻止默认并聚焦抽屉本身
  const bareRoot = mockDrawerRoot([]);
  (aside.props.ref as { current: unknown }).current = bareRoot;
  document.activeElement = {};
  const prevented = { calls: 0 };
  handler({ key: "Tab", shiftKey: false, preventDefault: () => { prevented.calls += 1; } });
  assert.equal(prevented.calls, 1, "无可聚焦控件时应阻止默认行为");
  assert.equal(bareRoot.focusCalls, 1, "无可聚焦控件时应聚焦抽屉本身");
});

test("语言切换通知即时同步入口与抽屉文案，卸载后释放订阅不再更新", async () => {
  const h = await harness({ storedOpen: "true" });
  renderSlot(h, h.header, { sessionId: "ledger" });
  h.react.runEffects(); await tick();
  h.react.runEffects();
  const headerZh = h.react.outputOf(h.header) as Element;
  assert.equal(textOf(headerZh), "余额", "入口初始应为中文文案");
  const drawerZh = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  h.react.runEffects();
  assert.ok(textOf(drawerZh).includes("账户余额"), "抽屉初始应为中文文案");

  // 仅发送语言切换通知：不触发 RPC，也无手动重绘，文案即时更新
  const callsBefore = h.rpc.calls.length;
  h.locale.setLocale("en");
  assert.equal(h.rpc.calls.length, callsBefore, "语言切换不得触发 RPC");
  const headerEn = h.react.outputOf(h.header) as Element;
  assert.equal(headerEn.type, "button");
  assert.equal(headerEn.props["aria-label"], "View account balances", "入口 aria 应即时切换");
  assert.equal(textOf(headerEn), "Balances", "入口文案应即时切换");
  const drawerEn = h.react.outputOf(h.drawer) as Element;
  assert.ok(textOf(drawerEn).includes("Account Balances"), `抽屉标题应即时切换：${textOf(drawerEn)}`);
  assert.ok(textOf(drawerEn).includes("Overview"), "页签文案应即时切换");
  const refreshIcon = findOne(drawerEn, (element) => hasClass(element, "icon") && element.props["aria-label"] === "Refresh balances", "刷新按钮缺失或未切换文案");

  // 卸载：释放 locale 订阅与文档监听，后续通知不再更新组件
  const disposedBefore = h.locale.stats.disposed;
  h.react.unmount(h.header);
  h.react.unmount(h.drawer);
  assert.ok(h.locale.stats.disposed > disposedBefore, "卸载应释放 locale 订阅");
  assert.equal(h.listenersOfType("visibilitychange").length, 0, "卸载应清理文档监听");
  h.locale.setLocale("zh");
  assert.equal(h.react.outputOf(h.header), undefined, "卸载后通知不得再更新组件");
  assert.equal(h.react.outputOf(h.drawer), undefined, "卸载后通知不得再更新组件");
});

test("概览与明细渲染真实账户、多商品、大数、负资产、负债溢缴与长列表", async () => {
  const h = await harness();
  const overview = await openDrawer(h);
  const sections = findAll(overview, (element) => classNameOf(element).includes("section-block"));
  assert.equal(sections.length, 2, "概览应有资产与负债两个分区");
  const assetSection = sections[0]!;
  const debt = sections[1]!;
  assert.ok(classNameOf(debt).includes("debt"), "第二个分区应为负债");
  const assetTotal = findOne(assetSection, (element) => classNameOf(element).includes("total-main"), "资产主金额缺失");
  assert.ok(textOf(assetTotal).includes("12,345,678,901,239,067.89"), `大数格式化错误：${textOf(assetTotal)}`);
  const debtTotal = findOne(debt, (element) => classNameOf(element).includes("total-main"), "负债主金额缺失");
  assert.ok(textOf(debtTotal).includes("1,150.00"), `负债应按欠款金额展示：${textOf(debtTotal)}`);
  assert.ok(textOf(debt).includes("按欠款金额展示"));
  assert.ok(textOf(debt).includes("1 个账户存在溢缴款"));
  assert.equal(findAll(overview, (element) => classNameOf(element).includes("mini-row")).length, 3, "概览应预览三条账户");

  const jump = findOne(overview, (element) => classNameOf(element).includes("jump"), "跳转链接缺失");
  (jump.props.onClick as () => void)();
  const details = renderSlot(h, h.drawer, { useSessions: useSessionsFor("ledger") });
  const rows = findAll(details, (element) => classNameOf(element).endsWith("dsh-moneypal-balance-account"));
  assert.equal(rows.length, 54, "明细应完整渲染全部 54 个账户");
  const rowTexts = rows.map((row) => textOf(row)).join("\n");
  assert.ok(rowTexts.includes("C-现金"), "账户名应保留 C- 前缀");
  assert.ok(rowTexts.includes("12,345,678,901,234,567.89"), "大数明细缺失");
  assert.ok(rowTexts.includes("0.30") && rowTexts.includes("USD"), "多商品明细缺失");
  assert.ok(rowTexts.includes("-500.00") && rowTexts.includes("已透支"), "负资产提示缺失");
  assert.ok(rowTexts.includes("-50.00") && rowTexts.includes("溢缴款 · 已多还"), "负债溢缴提示缺失");
  assert.ok(rowTexts.includes("1,200.00"), "普通负债应展示为正欠款");
  assert.ok(textOf(details).includes("资产合计") && textOf(details).includes("负债合计"), "分组合计缺失");
});

test("空账本呈现空状态与等待文案", async () => {
  const h = await harness({ balances: EMPTY_SNAPSHOT });
  const tree = await openDrawer(h);
  assert.ok(textOf(tree).includes("暂无账户余额"), "空账本未呈现空状态");
  assert.ok(textOf(tree).includes("刷新余额"));
  const footer = findOne(tree, (element) => classNameOf(element).includes("footer"), "状态栏缺失");
  assert.ok(textOf(footer).includes("等待余额"));
});

test("样式随生命周期卸载，重新安装不重复", async () => {
  const h = await harness();
  const styleId = "dsh-moneypal-balance-style";
  assert.equal(h.head.filter((style) => style.id === styleId).length, 1);
  const styleDisposer = h.effects.find((effect) => effect.name === "dsh-moneypal-balance.style()");
  assert.ok(styleDisposer, "样式未纳入 ctx.effect");
  styleDisposer!.dispose();
  assert.equal(h.head.filter((style) => style.id === styleId).length, 0, "样式未随生命周期卸载");
});
