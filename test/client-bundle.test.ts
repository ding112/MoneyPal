import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

type Style = { id: string; textContent: string; remove(): void };
type Definition = { name?: string; id?: string };
type Registration = { id: string; factory: (require: (name: string) => unknown) => { apply: (context: unknown) => void; inject: string[] } };

test("客户端 bundle 注册槽位、装载样式并随生命周期卸载", async () => {
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
  const disposers: Array<() => void> = [];
  const localeState = { disposed: false };
  const registered: { namespace?: string; dicts?: Record<string, Record<string, string>> } = {};
  const slots: Array<{ definition: Definition; component: unknown }> = [];
  const context = {
    window: {
      __ModuleLoader__: { load: (value: typeof registration) => { registration = value; } },
      localStorage: { getItem: () => null, setItem: () => undefined },
    },
    document,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  try {
    runInNewContext(source, context);
    assert.ok(registration, "bundle 未调用 __ModuleLoader__.load");
    assert.equal(registration!.id, "dsh-moneypal");
    const bundle = registration!.factory((name) => {
      if (name === "react") return {};
      throw new Error(`冒烟不应加载模块：${name}`);
    });
    assert.equal(typeof bundle.apply, "function");
    assert.deepEqual(Array.from(bundle.inject), ["sessions", "slots", "connection", "locale"]);
    bundle.apply({
      sessions: {},
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
    assert.equal(registered.namespace, "dsh-moneypal.balance");
    assert.ok(Object.keys(registered.dicts?.zh ?? {}).length > 0 && Object.keys(registered.dicts?.en ?? {}).length > 0, "locale 字典缺少 zh/en");
    assert.deepEqual(slots.map(({ definition }) => definition.id), ["dsh-moneypal-balance", "dsh-moneypal-balance-drawer"]);
    assert.deepEqual(slots.map(({ definition }) => definition.name), ["conversation.session.header.utilities", "shell.overlay"]);
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
