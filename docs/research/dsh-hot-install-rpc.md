# DSH 插件免重启安装：RPC 与注入热更新核查

核查日期：2026-10-27。目标环境：本机 DSH `0.2.1-rc.2`；区分 DSH 内置 Cordis 与 `cordiverse/cordis` 公共仓库。本报告记录外部证据与适配建议，不表示 MoneyPal 已实施迁移或通过免重启安装验收。

## 结论

有值得采用的方向。对 MoneyPal 当前版本，优先验证 **`connection.fetch.register` 注册 `/api/dsh-moneypal/<endpoint>`，客户端继续使用 `connection.rpc.call` 的消息格式**。已有真实插件采用这种组合；它不需要修改宿主 `connection` 行，因此能避开本次依赖补丁热应用缺陷。这里的“能避开”是代码路径推断，不是 MoneyPal 热安装实测结论。[真实插件宿主代码](https://github.com/inboxxobni/acryl-quick-notes/blob/b38bf86a4238fe84a36841217ea7347c0bf640d5/index.js)、[客户端代码](https://github.com/inboxxobni/acryl-quick-notes/blob/b38bf86a4238fe84a36841217ea7347c0bf640d5/client.js)、[只插入自身的 bundle patch](https://github.com/inboxxobni/acryl-quick-notes/blob/b38bf86a4238fe84a36841217ea7347c0bf640d5/cordis.patch.yml)

长期应由宿主修复 RPC 的服务解析，并正确应用 entry 的 `inject` 变化。公共 Cordis 已合并相关 Loader 重构，但不能据此声称 DSH 发布版已包含修复。[Cordis PR #245](https://github.com/cordiverse/cordis/pull/245)

## 官方文档与发行版

官方 `0.2.1-rc.1` 发布说明已经支持可替换插件的热更新、重装及依赖同步；无法热替换时提示重启。因此，安装插件普遍要求重启并非其目标行为，但官方也没有承诺所有包更新都可免重启。[rc.1 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)

固定到 `0.2.1-rc.3` 的框架文档说明：依赖服务消失时消费者卸载，服务恢复时重新加载；通过 Context 注册的资源会随插件清理。清理若有先后依赖，必须放在同一个 effect 的 disposer 内按顺序等待，不能假定多个异步 disposer 串行完成。[插件生命周期文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/user/develop/framework/index.md)

Connection 官方文档明确提供 exact Fetch 路由；Web carrier 统一拥有 `/api`、Fetch bridge、浏览器认证和 Host/Origin 检查。因此，使用 `/api` 中的精确路由有官方能力依据。将这些路由手动接到客户端 `rpc.call` 消息格式，则是社区插件采用的组合方式，不能称为官方迁移教程。[Connection README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/client/connection/README.md)

主调查核对最新发布的 `0.2.1-rc.3` 固定标签源码：RPC 注册仍直接访问 `owner.webServer.register(route)`；Fetch 注册只修改路由集合并用 `owner.effect` 管理移除。Loader 的 `_patchContext` 仍仅在 config/group 变化时调用 fiber.update，entry inject 合并仍位于首次绑定路径。**不能把升级 rc.3 当作已证实的修复。** 这是源码结论，本轮未执行 rc.3 安装后的动态复现。[RPC/Fetch 注册实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/client/connection/src/rpc-host.ts#L234-L276)、[Loader entry](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/vendor/loader/src/config/entry.ts#L101-L157)、[首次注入合并](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/vendor/loader/src/index.ts#L129-L135)

DSH 自带 vendored 源码，版本由 Harness 管理。rc.3 的供应清单仍记录 Cordis `4.0.0-rc.7`、Loader `1.0.0-rc.5` 的上游起点及宿主修改，不能拿公共 Cordis 最新包直接替换。[vendor 清单与修改记录](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/vendor/README.md)

## 社区已有同类报告

### DSH 官方讨论区：两个缺陷应分别处理

官方仓库的 [Discussion #9484](https://github.com/deepseek-ai/deepseek-harness/discussions/9484) 于 2026-10-12 报告 `0.2.0-rc.2` 的 `rpc.handle` 注册失败。10 月 16 日回复确认：调用方声明 `webServer` 仍失败；补宿主 `connection.inject` 可恢复冷启动。该回复还给出 Fetch 路由桥接方案及真实插件链接。10 月 18 日回复确认 `0.2.1-rc.2` 在冷启动与运行中启用时结果不同。

独立的 [Discussion #10121](https://github.com/deepseek-ai/deepseek-harness/discussions/10121) 于 2026-10-18 报告 `@tnnevol/dsh-codebuddy` 的同类问题：组合配置已经包含新 `inject`，存活 fiber 仍使用旧依赖。该讨论还记录多个 bundle 覆盖同一 `connection` 行时的冲突。**这是用户提交的复现和分析；本次读取的回复中没有维护者确认修复已发布。**

这与本轮 MoneyPal 的本地隔离复现一致，但社区报告自身不证明所有同名错误都来自同一个原因。普通插件直接读取未声明服务，也会产生相同错误文本。

### 直接注册 webServer 路由：有报告，成本较高

[`dsh-remote-web-gateway` issue #8](https://github.com/summer1238/dsh-remote-web-gateway/issues/8) 于 2026-10-10 报告 `0.2.0-rc.2` 的同一 RPC 问题，并描述直接注册 `webServer` 前缀路由后恢复。同一报告要求复制 RPC 消息处理并保留 `connection.requestRejection` 准入检查。截至本次核查，该 issue 为 open、没有评论，提交者不是仓库成员；未找到它被维护者采纳的证据。

因此，不把这段绕过代码作为 MoneyPal 首选。自行实现 HTTP RPC 会增加认证、消息校验、错误处理和生命周期维护面。仅按 loopback 地址放行不能自动等价于宿主原有的浏览器认证与 Host/Origin 规则。

## 可核对的真实插件方案

`inboxxobni/acryl-quick-notes` 的 `0.3.0` 提交为 `b38bf86a4238fe84a36841217ea7347c0bf640d5`，提交日期 2026-10-16。其 README 明确说从 `0.3.0` 开始支持原版 DSH；旧 `0.2.x` 依赖 ACRYL 对 `webServer` 的额外声明。[固定提交 README](https://github.com/inboxxobni/acryl-quick-notes/blob/b38bf86a4238fe84a36841217ea7347c0bf640d5/README.md)、[版本声明](https://github.com/inboxxobni/acryl-quick-notes/blob/b38bf86a4238fe84a36841217ea7347c0bf640d5/package.json)

核对到的实现是：

1. 宿主只注入 `connection`、`dshHomePath`，每个 endpoint 注册一个 `/api/acryl-quick-notes/<endpoint>` 精确 POST 路由。
2. 使用 `requestBody: 'buffered'`；读取 JSON，请求带 `client-request` 类型与 `rpcId`，响应返回 `server-response`、同一 `rpcId` 和业务结果。
3. 客户端调用 `connection.rpc.call('/api', 'acryl-quick-notes/<endpoint>', payload)`。
4. bundle 只插入插件自身，完全不修改 `connection.inject`。[宿主实现](https://github.com/inboxxobni/acryl-quick-notes/blob/b38bf86a4238fe84a36841217ea7347c0bf640d5/index.js)、[客户端实现](https://github.com/inboxxobni/acryl-quick-notes/blob/b38bf86a4238fe84a36841217ea7347c0bf640d5/client.js)、[bundle](https://github.com/inboxxobni/acryl-quick-notes/blob/b38bf86a4238fe84a36841217ea7347c0bf640d5/cordis.patch.yml)

证据边界：作者在 DSH 讨论区报告认证请求成功、未认证请求返回 401；源码和 README 确认所用方案，但没有完整证明“同一宿主进程安装、启用、停用、重装、服务恢复”全部通过。代码注释称路由随插件移除；实际资源归属仍须核对目标 DSH 的 `fetch.register` 实现，并做热卸载测试。不能照搬该插件的宽松消息校验作为 MoneyPal 的完整协议要求。

## Cordis 上游进展

| 项目 | 2026-10-27 核查状态 | 与本问题的关系 |
| --- | --- | --- |
| [PR #218](https://github.com/cordiverse/cordis/pull/218) | closed，未合并 | 专门处理存活 entry 的 name/inject 变化后仍保留旧 fiber；由 #245 取代。 |
| [PR #245](https://github.com/cordiverse/cordis/pull/245) | 作者 shigma；2026-10-22 已合并 | resolved inject/name 变化会重建 entry，等待旧实例清理后创建新实例。 |
| [Issue #243](https://github.com/cordiverse/cordis/issues/243) | 作者 shigma，MEMBER；open | 跟踪程序化 HMR、包级更新、缓存失效和插件管理；明确保留需要进程重启的情况。 |
| [PR #244](https://github.com/cordiverse/cordis/pull/244) | 2026-10-26 已合并 | 将 HMR 与文件监听分离，提供程序化 reconcile；不是所有安装都免重启的承诺。 |
| [PR #248](https://github.com/cordiverse/cordis/pull/248) | open、draft、未合并 | 计划在替换插件实现时保持 fiber 引用，并重新解析 inject；不能当作已发布能力。 |

`#245` 的源码确实比较 resolved inject，并在变化时 dispose + init；不是只改文案或增加测试。但它把 entry 注入移到 outer fiber，把插件放在 inner fiber，并更改 `entry.fiber` 等内部接口，具有不兼容变化。DSH 使用自己的内置/供应链版本，不能直接把公共 Cordis 的这份重构替换进去。[合并变更](https://github.com/cordiverse/cordis/pull/245/files)

公开 Cordis 最近的 GitHub Release 是 `4.0.0-rc.12`，发布时间 2026-10-21，早于上述合并。因此，本次没有取得“DSH 已发布此修复”的证据；也不能将公共 Cordis 的 rc 版本号与 DSH 内置的 `4.0.5` 作简单新旧比较。[Cordis 发布说明](https://github.com/cordiverse/cordis/releases/tag/v4.0.0-rc.12)

## 对 MoneyPal 的建议与验收边界

| 路径 | 建议 | 必须验证的边界 |
| --- | --- | --- |
| Fetch 路由 + 现有 RPC 消息格式 | 当前插件侧首选候选；免去对宿主 connection 行的补丁 | 客户端同步切换路径；完整消息校验；认证及 Host/Origin 行为；卸载和重复启用无残留。 |
| DSH RPC 内部建立正确的注入作用域 | 宿主侧长期修复候选；可保留插件现有 RPC API | 子作用域随调用方释放；webServer 丢失后清理、恢复后只注册一次；等待正式发布。 |
| Loader 重建受影响 entry | 解决通用 inject 热应用问题；参考 #245，不直接移植 | connection 重建会影响其下游；不等于整个过程连接完全不中断。 |
| 启用后重启后端 | 当前兼容兜底 | 明确它是 workaround，不能将刷新页面写成后端重启。 |

若实施 Fetch 方案，`src/host.ts` 与 `src/client.bundle.template.cjs` 必须同步迁移。旧 `/dsh-moneypal` 通道已经发布，应按协议变更处理客户端版本匹配、旧通道兼容与升级过程，不能只删 bundle patch 就交付。

建议的 MoneyPal 验收应使用干净临时 profile：先启动宿主，确认 connection 已运行，再安装并启用插件；记录宿主 PID 不变及 endpoint 可用。随后停用、再启用、重装同版本，并核对路由没有重复或残留。另测未认证请求、无效消息、请求取消、已有客户端的路径切换，以及 webServer 服务丢失后的恢复。上述是后续验收要求，本次研究未执行。

## 检索范围与未证实事项

本次通过 GitHub 连接器读取官方仓库信息、社区 issue、PR 状态与真实插件源码；通过网页读取 GitHub Discussions。检索包含 `webServer inject`、`rpc.handle restart`、`repo:cordiverse/cordis inject`，并沿相关链接读取上下文。DSH 官方仓库公开开放 Discussions，未开放 Issues/PR 提交通道。

已找到精确同类的热启用报告、作者维护的可用插件实现，以及公共 Cordis 已合并的相关 Loader 重构。尚未证实：某个 DSH 发布版已经解决 MoneyPal 的免重启安装；Fetch 桥方案在 MoneyPal 目标版本上完整通过热安装验收；所有包更新均可热替换。本报告没有向外部仓库发送消息，也没有修改运行时代码或用户宿主配置。

## 2026-10-27 实施与临时宿主验收

MoneyPal `1.0.0-rc.16` 已切换至 `/api/dsh-moneypal/capability` 与 `/api/dsh-moneypal/balances`，移除旧 `/dsh-moneypal` 通道和 connection 注入补丁。前后端同步更新，不保留旧客户端兼容。

在独立 DSH `0.2.1-rc.2` 临时 profile 中，先启动宿主，再安装构建包；插件两个组件均运行中。启用、停用、再次启用、卸载及重装期间宿主 PID 保持不变：停用和卸载后新接口返回 404，启用和重装后两个接口返回 200。无认证请求返回 401，不可信 Host 或 Origin 返回 403。旧路径返回 405，未再由原 RPC 通道处理。

在临时合成账本工作区选择 MoneyPal 预设，浏览器中的资产负债概览正常显示“暂无账户余额”。使用兼容 Python/Beancount 运行时执行 `npm run test:release`，集成测试、发布包测试和 tarball 验收通过。验证使用临时数据，不代表已发布或已更新用户正在运行的宿主。
