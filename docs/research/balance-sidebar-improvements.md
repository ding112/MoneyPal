# 余额侧边栏后续改进研究

## 结论

当前余额侧边栏已经避开参考报告里 Flowglass 最重的两类风险：它通过 DSH 原生 Slot 接入，而不是注入宿主 DOM；Host 返回结构化 `BalanceSnapshot`，Client 使用 React 渲染，而不是传递 HTML。它还具备 live session 工作区隔离、loopback 设计意图、精确十进制、多币种、请求取消、冷会话退避和安全错误净化。这些基础应保留。

下一阶段应优先处理：**真实 DSH RPC 权限契约、插件卸载生命周期、旧快照可信度、Host/Client 契约单一来源**。随后再优化轮询、模态语义、真实浏览器测试和多账户体验。

本研究以用户提供的 dsh-flowglass 报告作为检查清单；事实依据来自当前仓库源码、文档、测试，以及本机已安装 DSH 的公开类型。DSH 上游复核入口为 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/DeepSeek-Harness)。

## 已做得好的部分

- **Slot-first**：标题栏入口使用 `conversation.session.header.actions`，抽屉使用 `shell.overlay`，没有宿主 DOM selector。[`src/client.bundle.template.cjs:84`](../../src/client.bundle.template.cjs#L84)
- **结构化 UI 契约**：余额以 `BalanceSnapshot` 传输，React 直接渲染 DTO，不存在 Host HTML 或 `dangerouslySetInnerHTML`。[`src/balance.ts:8`](../../src/balance.ts#L8)
- **工作区隔离**：Client 只传 `sessionId`；Host 只从 live session 的 `header.cwd` 取得权威工作区，并忽略客户端附加路径。[`src/host.ts:22`](../../src/host.ts#L22) [`test/balance-host.test.ts:34`](../../test/balance-host.test.ts#L34)
- **精确金额**：金额跨边界保持十进制字符串，合计通过 `BigInt` 对齐小数位，不经过浮点数。[`src/balance.ts:41`](../../src/balance.ts#L41) [`test/balance-host.test.ts:144`](../../test/balance-host.test.ts#L144)
- **状态竞争防护**：会话切换会取消旧请求，请求完成前复核 session 与 request identity；冷会话使用 100/150/250/400/700ms 退避。[`src/client.ts:34`](../../src/client.ts#L34) [`src/client.ts:95`](../../src/client.ts#L95)
- **安全错误边界**：Host 返回稳定 code 与净化后的中文 message，日志不包含工作区、账本或异常正文。[`src/host.ts:34`](../../src/host.ts#L34) [`test/balance-host.test.ts:116`](../../test/balance-host.test.ts#L116)
- **基础 a11y 完整**：已有 dialog label、Escape、焦点进入与恢复、Tab 循环、tabs 方向键/Home/End、负值非颜色提示。[`src/client.bundle.template.cjs:58`](../../src/client.bundle.template.cjs#L58)

## P0：先解决正确性、安全边界和生命周期

### 1. 按真实 DSH API 重做 loopback 权限验证

仓库规范仍以 DSH 0.1.1-rc.2 / Cordis 4.0.1 为基线，并要求 RPC 使用 `authority: "loopback"`。[`docs/agents/dsh-plugin-development.md:5`](../agents/dsh-plugin-development.md#L5) [`docs/agents/dsh-plugin-development.md:27`](../agents/dsh-plugin-development.md#L27) 当前 Host 自建的 `handle` 类型允许第三个 options 参数，并传入 `{ authority: "loopback" }`。[`src/host.ts:10`](../../src/host.ts#L10) [`src/host.ts:22`](../../src/host.ts#L22)

但本机 DSH 0.1.2-rc.1 的公开 `HostConnectionRpc.handle` 类型只有 `(channel, handler)` 两个参数，而 Client Connection 公开 `isLoopback`。现有测试 mock 自己接受第三参数，然后断言该参数存在，因此只证明“代码传了参数”，不能证明真实 Host 执行了权限限制。[`test/balance-host.test.ts:28`](../../test/balance-host.test.ts#L28)

建议：

1. 先以目标 DSH 版本的官方源码/类型确认 Connection 的 loopback 权威实现，不再维护与宿主不一致的本地函数签名。
2. Client 可按公开 `isLoopback` 隐藏入口，但 Host 仍必须有权威拒绝；不能把前端隐藏当安全边界。
3. 用真实 DSH integration 验证 LAN origin/非 loopback 请求确实无法读取余额。
4. 将 0.1.1-rc.2、0.1.2-rc.1 及拟支持版本写成明确兼容矩阵。官方版本升级与 API 变化以 [DeepSeek Harness releases](https://github.com/deepseek-ai/DeepSeek-Harness/releases) 和仓库源码为准。

### 2. 将 Host、Client controller 和样式纳入 Cordis 生命周期

仓库规范要求一切注册与副作用随 Cordis 卸载释放。[`docs/agents/dsh-plugin-development.md:22`](../agents/dsh-plugin-development.md#L22) 当前 Host 丢弃了 `rpc.handle()` 返回的 disposer；Client 使用模块级 `controller`，`apply()` 创建 controller、插入全局 style、注册 Slot，却没有调用已有的 `controller.dispose()`，也没有移除 style。[`src/host.ts:21`](../../src/host.ts#L21) [`src/client.bundle.template.cjs:7`](../../src/client.bundle.template.cjs#L7) [`src/client.bundle.template.cjs:78`](../../src/client.bundle.template.cjs#L78) [`src/client.ts:93`](../../src/client.ts#L93)

这会让热更新、插件卸载或重复 apply 遗留 timer、请求、样式或重复注册。Host 与 Client 都应使用目标 DSH/Cordis 实际支持的 effect/disposer 接缝统一托管，并增加 `apply → dispose → 不再 RPC/调度` 的测试。

### 3. 修复能力探测异常和能力消失时的旧快照可信度

`probe()` 失败后仅把 capability 改为 unknown，没有把已有 snapshot 标为 stale，也没有记录可操作错误；Overlay 又会优先渲染 snapshot。[`src/client.ts:56`](../../src/client.ts#L56) [`src/client.bundle.template.cjs:69`](../../src/client.bundle.template.cjs#L69) 已打开抽屉在 session 暂时脱挂时可能继续显示旧余额，却没有“不可信”提示。

探测返回 ordinary 时也通过对象展开保留 snapshot/refreshedAt/error。[`src/client.ts:48`](../../src/client.ts#L48) 若同一 session 删除正式账本后又新建，持久化 open 偏好可能让旧账本快照在新请求完成前重新出现。

建议：已有快照时 probe failure 立即 `stale: true` 并显示稳定状态；candidate → ordinary 时原子清除 snapshot/refreshedAt/error、取消余额请求。补两条控制器测试：成功快照后 session_unavailable；同 session 删除并重建不同账本不闪旧数据。

### 4. 建立共享 RPC 契约并校验 Client 响应

Host 的成功值类型是 `unknown`；Client 有一套 `BalanceRpc` TypeScript 接口；发布 bundle 又手写双层 envelope 解包并直接返回 `inner.value`。[`src/host.ts:7`](../../src/host.ts#L7) [`src/client.ts:3`](../../src/client.ts#L3) [`src/client.bundle.template.cjs:86`](../../src/client.bundle.template.cjs#L86)

建议定义 endpoint、request、success DTO 与 error code 的单一共享模块，Host/Client 都引用它；Client 边界对 `asOf`、groups、accounts、commodity、quantity 做窄运行时校验。未知 code 统一降级，已知 code 映射“重试 / setup-runtime / 修复账本”等动作，UI 不解析中文 message。

## P1：刷新、a11y 和测试

### 5. 消除重复刷新，并逐步降低轮询成本

页面恢复可见时，`visibleChanged()` 同时调用 `probe()` 和 `refresh()`；probe 成功且 open 后又会调用一次 refresh，后者会取消前者。[`src/client.ts:43`](../../src/client.ts#L43) [`src/client.ts:89`](../../src/client.ts#L89) 每次余额请求最终都会启动隔离 Python bridge。[`src/balance.ts:13`](../../src/balance.ts#L13) [`src/finance/engine.ts:20`](../../src/finance/engine.ts#L20)

最低风险方案是 visibility 恢复只走“probe 后按需 refresh”一条路径，并对相同 session/asOf 做 single-flight。进一步可在目标 DSH 版本确认公开 session/Connection event 后采用“事件 invalidation + 合并后的权威 pull + 低频 polling 兜底”；不要自行增加 WebSocket。

### 6. 关闭或重开时明确旧快照的新鲜度

`toggle(true)` 保留旧 snapshot，仅设置 loading；UI 有 snapshot 时继续展示数据，页脚虽显示“正在刷新”，却不会标 stale。[`src/client.ts:82`](../../src/client.ts#L82) [`src/client.bundle.template.cjs:70`](../../src/client.bundle.template.cjs#L70) 关闭期间账本可能已改变。建议重开、页面恢复或 Connection generation 变化时立即标 stale，成功后原子替换；或首次重开先用 skeleton，避免旧数值看起来仍是新鲜数据。

### 7. 统一模态 ARIA 与真实交互模型

右侧 `aside` 只覆盖 360px，却声明 `role="dialog" aria-modal="true"`；实现没有 backdrop/inert，只手写了键盘 focus trap。[`src/client.bundle.template.cjs:63`](../../src/client.bundle.template.cjs#L63) [`src/client.bundle.template.cjs:73`](../../src/client.bundle.template.cjs#L73) 这会造成辅助技术的“模态”语义与指针仍可操作背景不一致。

应二选一：真正的全屏 modal wrapper/backdrop，并让背景不可交互；或把它定义为非模态补充面板，移除 `aria-modal` 和自制 trap。优先复用目标 DSH 官方公开的 Dialog/Drawer/details primitive（如有），公共 UI API 以 [DeepSeek Harness 官方源码](https://github.com/deepseek-ai/DeepSeek-Harness) 为准。

### 8. 增加结构语义并减少读屏打扰

账户和分组目前主要是 `div/span/p`，缺少 heading/list/table 语义；stale 使用 `role=alert`，连续后台失败可能重复打断读屏。[`src/client.bundle.template.cjs:28`](../../src/client.bundle.template.cjs#L28) [`src/client.bundle.template.cjs:52`](../../src/client.bundle.template.cjs#L52) [`src/client.bundle.template.cjs:71`](../../src/client.bundle.template.cjs#L71)

建议分组使用具名 heading，账户使用 `ul/li` 或 `dl`；首次且需操作的错误用 alert，重复后台失败只更新非打断 status；最后刷新时间使用 `time` 并提供完整日期时间的可访问文本。

### 9. 补真实 DSH 与浏览器门禁

现有余额自动化主要覆盖 Host、DTO、控制器和极简 VM 假 React；Client 测试只证明模块加载、候选 gating 和按钮 aria-label。[`test/balance-host.test.ts:34`](../../test/balance-host.test.ts#L34) [`test/balance-host.test.ts:58`](../../test/balance-host.test.ts#L58) tabs 键盘、焦点、overlay 指针、viewport、主题、重连、卸载/HMR、localStorage 异常和长列表仍依赖人工验收。

优先扩展现有零新增依赖测试覆盖 lifecycle、storage exception、probe stale 与重复 refresh；release acceptance 增加真实 DSH 的键盘、320/390/桌面宽度、亮暗主题、Connection 重连和非 loopback 拒绝。待仓库已有统一浏览器工具链后再增加 E2E，不为单一抽屉另建孤立框架。

### 10. localStorage 必须 best-effort

`getItem` 位于 probe try 内，异常会把 capability 退回 unknown；`setItem` 在 toggle 中未捕获，可能在状态已 emit 后抛错并阻止 refresh。[`src/client.ts:47`](../../src/client.ts#L47) [`src/client.ts:82`](../../src/client.ts#L82) 开关持久化不是核心财务能力，应捕获存储异常并降级为内存状态。

## P2：信息层级、规模性能和视觉一致性

### 11. 明确多币种主视觉，不用字母序冒充主币

合计按 commodity 字符串排序，概览再把第一项作为大号主金额。[`src/balance.ts:52`](../../src/balance.ts#L52) [`src/client.bundle.template.cjs:34`](../../src/client.bundle.template.cjs#L34) BTC/CNY 等组合下，主视觉只是字母序结果。应从 Beancount operating currency/用户设置得到 `primaryCommodity`，或让所有币种等权展示。

### 12. 优化大量账户的查找与概览采样

明细页直接渲染全部账户；v1 明确把搜索、过滤、分页和折叠排除在外。[`src/client.bundle.template.cjs:52`](../../src/client.bundle.template.cjs#L52) [`.scratch/account-balance-drawer/spec.md:110`](../../.scratch/account-balance-drawer/spec.md#L110) 下一版可先加纯 Client 本地搜索和分组折叠，不改 Host API、不持久化查询。

概览把所有资产放在负债前再截前三项，因此资产账户超过三个时完全看不到负债。[`src/client.bundle.template.cjs:42`](../../src/client.bundle.template.cjs#L42) 应保证两组至少各有一个代表项。

### 13. 修复路径重复并继续收敛 DSH design tokens

`Assets:Bank:Checking` 会显示 name=`Checking`、path=`Bank:Checking`，末段重复。[`src/client.bundle.template.cjs:27`](../../src/client.bundle.template.cjs#L27) 次级路径可改为 `parts.slice(1, -1)`，完整账户名放在 title/复制值中。

样式已使用部分 `--dsw-*` token，但仍是模板中的大段全局 CSS，且 `.is-negative` 未加命名空间。[`src/client.bundle.template.cjs:78`](../../src/client.bundle.template.cjs#L78) 建议复核宿主 surface/divider/focus/warning/shadow token，并补 safe-area、`100dvh`、forced-colors 和触控目标检查。中文文案是否迁入 locale，应等目标 DSH 的公开 locale API 核实后再决定。

## 文档与兼容性债务

余额规格仍保留迁移前的 `default/main.journal`、hledger、`/hledger-agent`、大小写不敏感根账户和 `{mantissa, decimalPlaces}`；当前代码实际是 `main.beancount`、Beancount bridge、`/dsh-moneypal`、大小写精确 `Assets/Liabilities` 和 `{commodity, quantity}`。[`.scratch/account-balance-drawer/spec.md:71`](../../.scratch/account-balance-drawer/spec.md#L71) [`src/host.ts:22`](../../src/host.ts#L22) [`src/balance.ts:25`](../../src/balance.ts#L25) [`src/finance/bridge.py:132`](../../src/finance/bridge.py#L132)

应先更新规格，再新增实现 ticket，否则后续 Agent 会按旧公开契约开发。Client manifest 中的注入包名也应在每个目标 DSH 版本做真实 loader 验证，而不是只检查 JSON 字段存在。[`packages/dsh-moneypal/package.template.json:36`](../../packages/dsh-moneypal/package.template.json#L36) [`test/balance-host.test.ts:49`](../../test/balance-host.test.ts#L49)

## 推荐实施顺序

1. 真实 DSH RPC/loopback 契约与兼容矩阵。
2. Host/Client 生命周期清理。
3. probe failure stale、candidate loss 清快照、重开 stale 和 storage 降级。
4. 共享 RPC 契约与 Client 响应验证。
5. visibility 单路径刷新、single-flight、事件 invalidation 可行性验证。
6. 模态语义决策与真实浏览器/a11y 门禁。
7. 主币种、搜索/折叠、概览采样、路径与 token 清理。

## 验证记录

2026-09-07 运行 `npm run test:fast`：余额相关 13 项全部通过；整个 fast suite 为 44/45，一个失败来自与余额无关的专家包中文简介长度门禁。因此不能把整套 fast tests 记为全绿，也不能用现有绿色余额 mock 证明真实 DSH API 兼容。

本研究没有修改余额实现、规格或测试。
