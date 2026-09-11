# DSH 插件开发规范

本文件是本仓库 DSH 与 MCP 插件开发的唯一权威规范，覆盖依赖边界、服务访问、注册语义、工具契约、错误边界和验证流程。修改插件入口、服务注入、工具契约、宿主注册、运行时依赖或发布流程前，必须先阅读本文并按其执行。

规范以当前安装的 DSH（0.1.2-rc.1）与 Cordis（4.0.2，随 DSH vendor 提供）的实际行为为准。外部文章、剪藏和针对旧 RC 版本的经验只作参考；升级 DSH 后必须重新核对实际 API，再更新本文与 `src/` 中的本地类型。

## 依赖边界

- 源码使用 TypeScript（`src/`），两个发布包（`dsh-moneypal`、`mcp-moneypal`）只包含预编译 JavaScript、`.d.ts` 和静态资源；不得把 TypeScript 源码作为运行时入口发布。
- DSH 后端代码只导入 Node 内置模块（`node:` 前缀）和包内相对模块。Cordis 服务是宿主能力，通过注入获得，不通过 npm 依赖获得。
- 发布包清单不得声明 `dependencies`、`devDependencies`、`optionalDependencies`、`peerDependencies`、`bundledDependencies`，也不得声明 `preinstall`、`install`、`postinstall` 等安装期脚本。
- 根工作区使用 npm：`packageManager` 固定为具体版本（当前 `npm@11.14.1`），继续使用 `package-lock.json`；不引入 pnpm 或 yarn 文件。
- MoneyPal 的 Python/Beancount 环境是显式的外部运行时：由 `setup-runtime` 安装或 `MONEYPAL_PYTHON` 指定。插件代码不得隐式安装、升级或静默更换解释器。

## 服务访问

- 硬依赖服务使用一维字符串数组 `inject` 声明（例如 `["tools", "userQuestions", "systemPrompt"]`、`["sessions", "connection"]`），使用稳定的服务名，不使用嵌套路径。
- 可选服务不写入 `inject`；使用前通过 `ctx.get(name)` 检查可用性，不可用时给出明确的错误或降级路径。
- `logger` 是 Cordis 内建服务，随 Context 必定存在：直接调用 `ctx.logger.warn(...)` 等方法，不写入 `inject`。本地类型把它建模为必需字段，不使用可选链。
- 不得用可选链掩盖未声明的服务；缺失的硬依赖必须显式失败，而不是静默降级。MCP 服务器是普通 Node 进程，不涉及 Cordis 注入，但工具契约与错误边界规则同样适用。

## 注册语义

- 工具、RPC 通道、system prompt section 和客户端 slot 都使用 `dsh-moneypal` 命名空间下的稳定名称；发布后不得改名。
- 同层重名必须 fail-loud：DSH/Cordis 对重复注册的官方语义是显式失败。不实现自动换名、覆盖或 fallback。
- 一切注册必须由 Cordis 生命周期持有：在 `apply(ctx)` 内通过注册 API 或 `ctx.effect` 完成，随插件卸载释放。模块作用域不得创建进程级单例、定时器、句柄或文件副作用。
- 全局 RPC 适配器固定 `authority: "loopback"`；客户端不能传入账本路径，宿主只从当前已挂载会话解析工作区。

## 工具契约

- `ctx.tools.register` 必须提供完整 JSON Schema：`parameters` 与 `output` 都写出字段级约束，不用空 schema 交差。
- DSH 与 MCP 共用 `src/finance/contract.ts` 中的财务领域契约。MCP 适配器可在查询、校验和预览的输入 Schema 上组合宿主专用的 `ledgerWorkspace`，但不得复制或改写共享的财务字段；DSH 仍从会话取得工作区。
- 工具名、参数名、错误码和输出字段是公开契约：只能新增，不能改名或删除；破坏性变更必须升版本并在发布说明中声明。
- 错误统一使用 `FinanceError` 与 `errorResponse` 的结构化形状：`code` 加 `message`，需要修复指引时附 `diagnostics`。

## 错误边界

- 工具边界、RPC 边界、子进程边界和文件写入边界都必须捕获异常，并净化为稳定、可操作的结构化信息；原始异常文本、文件路径、解释器输出和堆栈不得进入对外响应。
- 日志只记录稳定的事件码与固定消息（例如 `dsh-moneypal balance RPC <code>`），不记录账本细节、路径或原始异常。
- 写入操作 fail-closed：失败即保持账本不变；需要人工确认的写入绝不跳过确认；结果不确定（`write_outcome_uncertain`）时禁止自动重试，必须先查询正式账本，再由人决定下一步。

## 专家包产物线

专家包由 `scripts/build-expert.mjs` 在 `npm run build` 中一次性产出两个结构互斥的 ZIP，源材料均为 `experts/moneypal/` 与仓库根 `skills/mcp-moneypal/`：

- WorkBuddy：`dist/experts/moneypal.zip`，ZIP 顶层为单一 `moneypal/` 目录，包含 `.codebuddy-plugin/plugin.json` 清单与头像；不得混入 `.qoder-plugin/`。
- Qoder：`dist/experts/moneypal-{version}.zip`（版本取自 `.qoder-plugin/plugin.json`），ZIP 根目录即插件根，只包含 `.qoder-plugin/plugin.json`、`agents/`、`skills/mcp-moneypal/`、`README.md`、`CONNECTORS.md` 与 `.mcp.json`；不得混入 `.codebuddy-plugin/` 或 `avatars/`。

两个清单的 `version` 必须一致；Qoder 清单路径声明必须以 `./` 开头且 JSON 路径以 `.json` 结尾。这些不变量与两个 ZIP 的打包结构由 `expert-package` 测试守护。修改专家包内容、清单或打包脚本后运行 `npm run test:fast`；涉及发布流程时仍按上文要求运行 `npm run test:release`。

## 测试撰写标准

本标准适用于本仓库所有测试。目标是用最少的维护成本守住业务行为和关键风险；新增函数、重构或修改文件本身不构成新增测试的理由。

### 新增测试的准入流程

1. 明确要防止的具体回归：新增业务规则、已发生的缺陷，或尚未覆盖的高风险边界。只为覆盖代码分支、提高覆盖率或满足“每次改动都加测试”而提出的用例不予新增。
2. 先搜索相关测试与夹具，检查实际断言。已有用例能覆盖时直接复用；行为发生变化时更新原用例；只有不同的可观察结果或独立风险才新增用例。真实缺陷优先补充能在修复前失败、修复后通过的最小回归验证。
3. 选择能证明该行为的最低必要层级，按下表确定归属；列清已有覆盖后再写测试，不在多个层级重复完整场景矩阵。

| 测试层级 | 负责验证 | 新增限制 |
| --- | --- | --- |
| 领域与控制器 | 日期、金额、账户、批次、状态转换等规则 | 普通功能默认一个代表性成功场景；失败用例只覆盖不同处理结果，不枚举等价输入 |
| DSH/MCP/宿主适配器 | 协议接线、授权、错误转换、生命周期 | 保留代表性往返；只为适配器独有行为增加场景，不重测领域规则全量组合 |
| 进程、文件与真实运行时 | 原子写入、并发、取消、隔离及真实会计语义 | 用真实边界证明风险，不能用固定假结果声称已验证运行时语义 |
| 发布产物 | 实际包入口、资源、清单约束、隔离安装 | 放入发布层；不因新增产物检查把打包带回日常快速测试 |
| UI | 发布前的布局、焦点、键盘与交互验收 | 样式、文案、布局修改默认不新增自动测试；按下方发布 UI 清单验收。新增业务状态按领域与控制器层规则处理 |

### 断言与夹具

- 断言可观察的行为、公开契约或数据安全。源码组织、私有方法调用顺序、脚本整串写法、固定发布版本、文档措辞、CSS 数量和像素不是测试目标。协议顺序或确认先于写入等本身属于行为契约的要求仍应验证。
- 公开工具名、参数约束、错误码和输出字段应保留验证。描述性文案不逐字比较；忽略 Schema 描述时必须保留名为 `description` 的业务字段。错误净化检查验证敏感信息未泄露，不以整段提示文字相等替代。
- 一个测试围绕一个可解释的行为组织断言；相同规则的等价输入使用少量代表值。既不拆成大量同义用例，也不为降低数量把无关风险塞入一个巨型测试。
- 使用现有 `node:test` 与简单、局部的夹具。只有确有重复准备工作时才提取公共辅助函数；不为测试自建 React、DOM、协议解析器或通用模拟框架。需要新依赖或测试基础设施时，先单独说明必要性及现有工具无法满足的原因。
- 涉及账本写入时使用临时合成账本；测试完成或失败均清理临时文件、计时器、监听与子进程。优先使用已有可注入时钟或完成信号，避免靠任意延时等待结果。

### 高风险例外与维护要求

- 写入确认、取消零写入、原子性、并发互斥、写入结果不确定、金额精度、会话与路径隔离、错误净化，按独立失效方式保留充分覆盖。“一个代表场景”不限制这些风险的测试数量。
- 同一行为需要跨层验证时，必须说明新增层独有的风险，例如领域写入成功不能证明 MCP 取消通知会终止子进程。仅换入口、改参数值或复述结果不构成独立风险。
- 修改功能时同步清理失效和重复的测试；删除前指出替代覆盖位置，或明确说明产品行为已移除、覆盖已按本标准转入发布验收。不能通过跳过、弱化断言或删除有效保护测试来掩盖回归。
- 不要求每个函数都有测试，不要求每次改动新增测试，不设置统一覆盖率或测试数量上限。测试数量、行数和耗时增长仅作为审查信号；不能为满足缩减比例牺牲关键风险覆盖。

每次新增测试，在改动说明（issue、PR 或最终交付说明中任选一处）简要回答以下三问；同一理由可按组说明，不在每个测试文件重复记录：

1. 防止什么具体回归？
2. 为什么已有测试不能覆盖？
3. 为什么应在这一层验证？

三问回答不清楚时，先不新增测试，继续核对行为与已有覆盖。仅调整测试实现或删除重复用例时，说明保留了哪些行为覆盖即可。

## 验证流程

- 单次小改动：`npm run build:base` 后运行对应的 `dist/test/<文件>.test.js`，例如 `npm run build:base && node --test dist/test/balance-host.test.js`。`build:base` 会清空 `dist`，构建产物只对应最后一次源码，修改后不能省略重新编译。
- 阶段性快速验证：`npm run test:fast`；合并前：`npm test`；涉及发布、包入口、Schema、注入、宿主注册、依赖或发布流程的改动：`npm run test:release`。
- `build:base` 清空 `dist` 并生成基础产物；`npm run build` 额外装配两个发布包与专家 ZIP。任何 `:built` 命令要求对应构建刚完成。
- 本地集成（`npm test`）允许明确跳过缺失真实运行时的 18 项；发布（`npm run test:release`）严格要求真实运行时可用兼容。
- 发布 UI 验收只在发布前通过 ego-browser skill 执行；日常测试不包含 React/DOM 模拟器或浏览器测试。
- `npm run test:fast`、`npm test`、`npm run test:release` 三个命令相互包含，不要用它们重复验证同一次修改：按所处阶段选择相应的最高层级即可；单独诊断失败文件时不受此限制。
- `npm run test:release` 只完整构建一次，随后执行 `npm run verify:release:built`（发布测试 + 真实 tarball 打包、内容检查、隔离安装与入口加载）。`verify:release:built` 自身不构建、不安装运行时，要求调用方已完成 `npm run build` 与 `node dist/src/main.js setup-runtime`；`pack:check` 与 `pack:check:built` 只作手工排查，不在正式验收链路里。
- 版本改动经过审查：维护者用 `npm version <明确版本> --no-git-tag-version` 更新根版本（该命令只改根清单与 lockfile，不提交、不打 tag），审查差异后经 PR 合入 `main`，再对已合入的提交创建 annotated tag 并只推送该 tag（`git push origin refs/tags/v<版本>`）；不要用 `git push --tags`，也不要在 CI 里升版本。
- Release 工作流只接受 `push.tags: ['v*']`，发布已经通过门禁的 tgz（`scripts/publish-release.mjs`），npm 使用 OIDC 发布到 `next` 且不读取 `NPM_TOKEN`，`latest` 保持人工提升；不要新增工作流、绕过门禁或在发布流程里改动 dist-tag。Test 与 Release 工作流都会执行 `npm ci` → `npm run build`（每个 job 只完整构建一次）→ `node dist/src/main.js setup-runtime` → `npm run verify:release:built`，因为发布门禁严格要求真实运行时。发布失败时在新 tag 工作流的原运行中选择 **Re-run failed jobs**，不重新推送、删除或移动 tag。

### 发布 UI 验收清单（仅发布前执行）

执行前先读取 ego-browser skill（`~/.agents/skills/ego-browser/SKILL.md`），再用真实运行时逐项验收；每项记录通过/失败，故障与空账本数据一律使用临时合成账本，不得使用个人正式账本：

1. 桌面 1280px：余额入口位于会话标题栏右侧工具区；仅 MoneyPal（`dsh-moneypal`）会话显示，非 MoneyPal 会话（含有账本的普通会话）一律不显示。
2. 桌面 1280px：首次进入 MoneyPal 会话自动展开；手动关闭后入口重现、重新打开恢复；切换会话状态正确；关闭偏好刷新页面后保留。
3. 桌面 1280px：Tab/Shift+Tab 在抽屉内循环、Escape 关闭（非模态，背景对话仍可操作）；关闭后焦点回到入口。
4. 移动 390px：默认不展开；图标可点击；打开后为模态抽屉、遮罩隔离背景、Tab 循环、Escape/关闭按钮/遮罩关闭后焦点恢复到入口。
5. 运行时故障时刷新失败：保留既有余额数据并提供重试，重试成功恢复。
6. 无账本会话呈现“尚未发现账本”与重试入口；空账本呈现空余额状态——两者文案不同；多币种账本各币种分别列示。
7. 卸载插件后入口、抽屉消失，样式移除。

正式发布仍须在干净 checkout 中另行运行 `npm run release:preflight`，再按发布验收记录完成 registry 与真实宿主验证。全部通过后检查最终差异：确认没有 pnpm 文件、构建生成物或公开契约漂移进入提交。
