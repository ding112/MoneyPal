# DSH 0.2.0 系列官方变更核查

核查日期：2026-10-04。范围为 `0.1.7-rc.2 → 0.2.0-rc.2`；本文件记录上游证据与适配建议，不表示 MoneyPal 已完成升级验证。

## 版本基线

- 本机执行 `dsh --version` 得到 `0.2.0-rc.2`；`/usr/local/bin/dsh` 指向官方桌面应用内置启动器。应用内 `@deepseek-ai/dsh-web-app/package.json` 的版本也是 `0.2.0-rc.2`。
- 官方发布页将 `0.2.0-rc.1`（9 月 28 日，`4878cda`）和 `0.2.0-rc.2`（9 月 29 日，`639ed01`）都标为预发布。应把当前适配目标写成完整版本号，不能写成已经验证了无后缀正式版。[rc.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)、[rc.2 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)
- 核查时官方发布列表另有 `0.2.1-alpha.1`，未见无后缀 `0.2.0` 发布项；不能拿最新主分支当作 `0.2.0` 的契约。[官方发布列表](https://github.com/deepseek-ai/deepseek-harness/releases)

## 与 MoneyPal 最相关的变化

发布说明不是完整的插件迁移指南。结合本仓库与官方发布包的静态核对，本轮应优先处理以下具体接点：

1. **更新客户端依赖声明。** `packages/dsh-moneypal/package.json` 的 `dsh.client.inject` 仍有 `@deepseek-ai/dsh-client-runtime`，本机 rc.2 发布包已无该包，`sessions` 由 `@deepseek-ai/dsh-api-session-controller/client` 提供。应把依赖声明迁到实际提供者，检查构建检查及测试是否仍固化旧名称。[本仓库声明](../../packages/dsh-moneypal/package.json)、[官方会话控制器客户端源码](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.0-rc.2/packages/api/session-controller/src/client/index.ts)
2. **迁移 RPC 类型和权限验证。** `src/host.ts` 仍用第三参数 `{ authority: "loopback" }` 表达授权边界；rc.2 实际 `rpc.handle` 只接收通道和处理函数，处理函数可获得第四个 `peer` 参数。旧 options 在 JavaScript 层被忽略，不能再用自制 mock 断言 options 来证明宿主强制执行 loopback。必须明确 MoneyPal 在宿主浏览器认证与 Host/Origin 检查之上的访问策略，并在真实宿主验证后修订类型、调用、测试与文档；直接删除 options 不等于保持了原权限语义。[当前实现](../../src/host.ts)、[当前 mock 测试](../../test/balance-host.test.ts)。上游依据为本机 rc.2 官方发布包的连接/RPC 实现；主调查已核对。
3. **更新兼容与安装说明。** 将验证目标明确为 `0.2.0-rc.2`，区分桌面内置 CLI 与独立 Web/开发环境的安装前提。Python/Beancount 是否需要单独准备须按 MoneyPal 自己的启动代码说明，不能把宿主“无需 Node/pnpm”扩展为所有运行时均不需要。

客户端依赖的影响有明确边界：官方 rc.2 `dsh-client-modules/lib/client.js` 的 `arriveGraphRow` 会跳过图中不存在的 `inject` 名称，因此仅旧 manifest 声明不能证明插件已经无法加载；如果代码真正 `require/import` 不存在的旧包才会抛模块解析错误。这里已经确认的是加载依赖声明失效，仍需真实宿主验证启动和重载。该行为直接核对了本机官方 `app.asar` 内发布代码。

| 变化 | 上游事实 | 对 MoneyPal 的建议（推断） |
| --- | --- | --- |
| 桌面内置 CLI | rc.2 可从菜单安装和管理 `dsh`，插件管理无需另装 Node/pnpm。 | 安装文档增加桌面安装路径；区分宿主运行环境、开发环境以及 MoneyPal 自身 Python/Beancount 运行时要求。 |
| 图形启动的环境 | rc.2 修复 macOS/Linux 图形启动未加载登录 shell 环境。 | 复核桌面启动时 MoneyPal 的 Python 可执行文件发现、环境继承与桥接启动，避免只在终端验证。 |
| 插件管理 | rc.1/rc.2 改善安装、配置保存与兼容性提示。 | 用目标宿主核对发布包兼容声明及安装/启停流程；发布说明本身没有证明旧插件必然兼容。 |
| 自动化 | rc.1 把自动化任务移到可选组合包；rc.2 改善定时消息的表达。 | 定时对账、账单提醒可以作为后续能力，但应明确可选依赖，不能假设所有 0.2.0 用户默认具备。 |
| 工具失败恢复 | rc.1 改善调度失败后的继续对话，并要求结果未知时先核实副作用。 | 核对记账写入在中断/恢复后是否重复执行，保留现有写入确认与结果核验边界。 |
| 模型目录 | rc.2 升级第三方模型目录，移除了部分旧模型 ID。 | 若文档或测试固定旧模型，更新选择；MoneyPal 不应复制宿主模型清单。 |

上述事实分别来自 [rc.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1) 与 [rc.2 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)。

## 异步问答是可选能力，不是默认行为

`@deepseek-ai/dsh-tool-ask-user` 新增 `mode: timed`，默认仍为 `legacy`；前台等待默认 120 秒。标准预设只注册 `tool-ask-user`，没有开启 timed 配置。因此仅升级宿主不会自动把所有问题变成异步问答。[配置源码](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.0-rc.2/packages/interaction/tool-ask-user/src/index.ts)、[标准预设](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.0-rc.2/packages/bundle/web-app/presets/standard.patch.yml)

timed 工具超时返回 `pending: true`、`callId` 与提示；后续回答以关联原工具调用的用户消息送达。`timeout: -1` 继续等待必要回答。源码明确区分“等待中”和“用户跳过”，且超时不是授权。[timed 问答源码](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.0-rc.2/packages/interaction/tool-ask-user/src/timed.ts)

建议：可评估在分类偏好、备注补充等非阻塞交互中启用；记账金额、账户、写入确认不能把超时当作同意。若 MoneyPal 直接调用 `ctx.userQuestions.ask`，须按实际服务调用路径评估，不能只因模型侧工具新增 timed 模式而认定必须改返回值。

## 标准预设必须按标签核对

rc.2 的标准预设包含 `planning`、`compaction`、`delegation` 分组及隔离配置，并注册问答、Web 搜索、展示等工具。复刻预设的插件应以该标签下文件比较；本机应用包中的标准预设与此官方路径对应。本文件不把这些既有能力全算成 0.2.0 新增。[rc.2 标准预设源码](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.2.0-rc.2/packages/bundle/web-app/presets/standard.patch.yml)

本轮主调查已将 MoneyPal 预设去掉末尾两个 MoneyPal 专属项后的标准插件块，与本机 rc.2 标准块逐字节比较，结果相同。因此不需要为版本号重写现有预设。静态核对还确认会话标题栏/浮层 slot、会话 projection、locale、工具注册、system prompt section 和同步 `userQuestions.ask` 接点仍在；没有发现需要因此重写 Beancount 核心的依据。

## 不应混入本轮的 0.2.1 变更

以下属于 `0.2.1-alpha.1`，不能当作适配 `0.2.0-rc.2` 的要求：自动化重新内置 Web；子路径插件不再读取独立 `package.json`；移除运行时 invariant 插件及 `./invariant` 导出；输入区 `stats` 拆为 `activity`/`usage`；开发监听刷新入口和依赖映射，以及插件启停样式修复。将来升级 0.2.1 时再逐项评估。[0.2.1-alpha.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.1)

## 证据边界

本次已读官方发布说明、固定标签源码与本机官方发布包；未把第三方发行包的迁移摘要当作事实。例如“升级 0.2.0 才引入 V3 日志”“0.2.0 才内置上传”尚无充分的旧版对比证据，不列为本轮新增。

本报告只做静态核验，未执行真实 DSH 端到端测试。后续验证应覆盖桌面安装/启停、MoneyPal 会话余额入口、RPC 授权边界、写入确认与中断恢复。自动化与异步问答是可选产品增强，优先用于只读提醒和独立澄清；涉及账本写入继续等待明确确认。

## 0.2.1-rc.2 追加核查（2026-10-17）：`webRuntime` → `webStartup`

本节记录本机升级到 `0.2.1-rc.2` 后的真实启动故障与修复依据，不属于上面的 0.2.0 静态核查。

- 0.2.1-rc.2 的 `@deepseek-ai/dsh-web-app/lib/startup.js` 提供 `webStartup`；0.2.0-rc.2 的 `WEB_RUNTIME_SERVICE = "webRuntime"` 在该版本已不存在，宿主 `app.asar` 内小写 `webRuntime` 为 0 处。
- `dsh-moneypal@1.0.0-rc.14` 的 bundle patch 仍把 `connection` 的 inject 写成 `[webRuntime, webServer]`。required 的 `connection` 因此永久等待不存在的服务，启动日志为 `connection (required) missing webRuntime`，并连带 8 个下游插件（含 `dsh-moneypal`）未激活。
- 热启用时 `connection` 已按原生 `[webStartup]` 运行，`connection.rpc.handle` 在注册路由时读取 `owner.webServer`，而该服务解析回退到 connection 提供者 Context 的 inject，于是抛出 `cannot get property "webServer" without inject`，`dsh-moneypal` 激活失败。
- 修复：补丁改为 `[webStartup, webServer]`，同步 release 门禁与 package-split 断言。不要给 `dsh-moneypal` 自身追加 `webServer`：Cordis 的服务 getter 在读取时使用提供者 Context 的 inject，调用方注入不生效。
- 影响面：本机桌面 profile 与 web profile 都安装 rc.14，且都受同一补丁影响。0.2.0 与 0.2.1 不能共用同一个注入名，发布包必须明确支持的 DSH 版本。
- 另：0.2.1-rc.2 的 standard 预设包含 `time-context`、`tool-schedule`、`tool-plugin-market`；`presets/moneypal.patch.yml` 仍是 0.2.0 快照，缺少后两者，需另列预设同步任务，不与本次注入修复混做。
