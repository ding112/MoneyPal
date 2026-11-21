import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type Style = { id: string; textContent: string; remove(): void };
type Definition = { name?: string; id?: string; key?: string; order?: number };
type Registration = { id?: string; factory: (require: (name: string) => unknown) => { apply: (context: unknown) => void; inject: string[] } };

/** 共用夹具：读取 bundle 源码并装配 document、样式收集器与 __ModuleLoader__。
 * localStorage 以 getter 挂载，取值函数返回值即属性读数、抛错即模拟受限浏览器访问属性即抛错；
 * 返回工厂加载出的 bundle 与样式收集器，注册细节由各用例自行捕获断言。 */
async function loadBundle(localStorage: () => unknown) {
  const source = await readFile(new URL("../src/client.bundle.cjs", import.meta.url), "utf8");
  const styles = new Map<string, Style>();
  const document = {
    visibilityState: "visible",
    getElementById: (id: string) => styles.get(id) ?? null,
    createElement: (tag: string) => {
      assert.equal(tag, "style");
      const style: Style = { id: "", textContent: "", remove: () => { styles.delete(style.id); } };
      return style;
    },
    head: { append: (style: Style) => { styles.set(style.id, style); } },
  };
  let registration: Registration | undefined;
  const window: Record<string, unknown> = { __ModuleLoader__: { load: (value: typeof registration) => { registration = value; } } };
  Object.defineProperty(window, "localStorage", { get: localStorage });
  runInNewContext(source, { document, window, AbortController, setTimeout, clearTimeout });
  assert.ok(registration, "bundle 未调用 __ModuleLoader__.load");
  const bundle = registration!.factory((name) => { if (name === "react") return {}; throw new Error(`不应加载模块：${name}`); });
  return { styles, bundle, registration: registration! };
}

test("客户端 bundle 注册独立账户页面板、装载样式并随生命周期卸载", async () => {
  const { styles, bundle, registration } = await loadBundle(() => ({ getItem: () => null, setItem: () => undefined }));
  const slots: Array<{ definition: Definition; component: unknown }> = [];
  const disposers: Array<() => void> = [];
  const localeState = { disposed: false };
  const registered: { namespace?: string; dicts?: Record<string, Record<string, string>> } = {};
  try {
    assert.equal(registration.id, "dsh-moneypal");
    assert.equal(typeof bundle.apply, "function");
    // 独立账户页不读取会话：不再注入 sessions。
    assert.deepEqual(Array.from(bundle.inject), ["slots", "connection", "locale"]);
    bundle.apply({
      connection: { rpc: { call: async () => { throw new Error("冒烟不应调用 RPC"); } } },
      effect: (callback: () => () => void) => { const dispose = callback(); disposers.push(dispose); return dispose; },
      slots: {
        inject: (_name: string, callback: () => void) => { callback(); },
        register: (definition: Definition, component: unknown) => { slots.push({ definition, component }); return () => undefined; },
      },
      locale: {
        register: (namespace: string, dicts: Record<string, Record<string, string>>) => { registered.namespace = namespace; registered.dicts = dicts; return () => { localeState.disposed = true; }; },
        bind: () => (key: string) => key,
        subscribe: () => () => undefined,
        getLocale: () => ({ active: "zh", locales: [] as string[], revision: 0 }),
      },
    });
    assert.equal(registered.namespace, "dsh-moneypal.accounts");
    assert.ok(Object.keys(registered.dicts?.zh ?? {}).length > 0 && Object.keys(registered.dicts?.en ?? {}).length > 0, "locale 字典缺少 zh/en");
    // 视图模型输出的引导键与重新检测入口必须在两种语言的字典中存在，否则页面显示原始键名。
    for (const key of ["page.recheck", "choice.guide.uninitialized", "choice.guide.invalid_layout", "choice.guide.unavailable"]) {
      assert.ok(key in (registered.dicts?.zh ?? {}), `zh 字典缺少 ${key}`);
      assert.ok(key in (registered.dicts?.en ?? {}), `en 字典缺少 ${key}`);
    }
    // ADR-0006：同一面板 ID 同时注册 sidebar.panellist 入口与 main keyed 面板。
    assert.deepEqual(slots.map(({ definition }) => definition.name), ["sidebar.panellist", "main"]);
    assert.equal(slots[0]?.definition.id, "dsh-moneypal-accounts");
    assert.equal(slots[1]?.definition.key, "dsh-moneypal-accounts");
    assert.equal(slots[0]?.definition.order, 20);
    assert.ok(slots.every(({ component }) => typeof component === "function"), "槽位必须注册组件");
    assert.equal(styles.size, 1);
    const style = styles.get("dsh-moneypal-balance-style");
    assert.ok(style, "样式未按命名空间 id 安装");
    assert.ok(style!.textContent.length > 0 && !style!.textContent.includes("__CLIENT_STYLES__"), "bundle 未嵌入命名空间样式");
  } finally {
    for (const dispose of [...disposers].reverse()) dispose();
  }
  assert.equal(styles.size, 0, "卸载后样式应移除");
  assert.equal(localeState.disposed, true, "locale 注册应随生命周期卸载");
});

test("bundle 在 localStorage 不可用时仍完成注册并装配样式", async () => {
  // 受限浏览器在访问 window.localStorage 属性本身时即抛错（非读写失败）：bundle 不得因此崩溃。
  const { styles, bundle } = await loadBundle(() => { throw new Error("localStorage access denied"); });
  const definitions: Definition[] = [];
  const disposers: Array<() => void> = [];
  try {
    bundle.apply({
      connection: { rpc: { call: async () => { throw new Error("冒烟不应调用 RPC"); } } },
      effect: (callback: () => () => void) => { const dispose = callback(); disposers.push(dispose); return dispose; },
      slots: {
        inject: (_name: string, callback: () => void) => { callback(); },
        register: (definition: Definition) => { definitions.push(definition); return () => undefined; },
      },
      locale: {
        register: () => () => undefined,
        bind: () => (key: string) => key,
        subscribe: () => () => undefined,
        getLocale: () => ({ active: "zh", locales: [] as string[], revision: 0 }),
      },
    });
    assert.deepEqual(definitions.map(({ name }) => name), ["sidebar.panellist", "main"], "存储不可用时面板注册不受影响");
    assert.equal(styles.size, 1, "存储不可用时样式仍装配");
  } finally {
    for (const dispose of [...disposers].reverse()) dispose();
  }
  assert.equal(styles.size, 0, "卸载后样式应移除");
});
