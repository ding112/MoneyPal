# DSH 插件开发规范

本文件是本仓库 DSH 与 MCP 插件开发的唯一权威规范，覆盖依赖边界、服务访问、注册语义、工具契约、错误边界和验证流程。修改插件入口、服务注入、工具契约、宿主注册、运行时依赖或发布流程前，必须先阅读本文并按其执行。

规范以当前安装的 DSH（0.1.1-rc.2）与 Cordis（4.0.1）的实际行为为准。外部文章、剪藏和针对旧 RC 版本的经验只作参考；升级 DSH 后必须重新核对实际 API，再更新本文与 `src/` 中的本地类型。

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
- DSH 与 MCP 共用同一份契约定义（`src/finance/contract.ts`）：工具名、描述、参数 Schema 和输出形状单一来源，两个包不得各自漂移。
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

## 验证流程

- 单次小改动：`npm run build:base` 后运行对应的 `dist/test/<文件>.test.js`，例如 `npm run build:base && node --test dist/test/balance-host.test.js`。`build:base` 会清空 `dist`，构建产物只对应最后一次源码，修改后不能省略重新编译。
- 阶段性快速验证：`npm run test:fast`；合并前：`npm test`；涉及发布、包入口、Schema、注入、宿主注册、依赖或发布流程的改动：`npm run test:release`。
- `build:base` 清空 `dist` 并生成基础产物；`npm run build` 额外装配两个发布包与专家 ZIP。任何 `:built` 命令要求对应构建刚完成。
- 本地集成（`npm test`）允许明确跳过缺失真实运行时的 18 项；发布（`npm run test:release`）严格要求真实运行时可用兼容。
- 发布 UI 验收只在发布前通过 ego-browser skill 执行；日常测试不包含 React/DOM 模拟器或浏览器测试。
- `npm run test:fast`、`npm test`、`npm run test:release` 三个命令相互包含，不要用它们重复验证同一次修改：按所处阶段选择相应的最高层级即可；单独诊断失败文件时不受此限制。

### 发布 UI 验收清单（仅发布前执行）

执行前先读取 ego-browser skill（`~/.agents/skills/ego-browser/SKILL.md`），再用真实运行时逐项验收；每项记录通过/失败，故障与空账本数据一律使用临时合成账本，不得使用个人正式账本：

1. 桌面 1280px：普通会话不显示余额入口；账本会话显示入口。
2. 桌面 1280px：抽屉打开、关闭与切换会话后入口/抽屉状态正确。
3. 桌面 1280px：Tab/Shift+Tab 在抽屉内循环、Escape 关闭（非模态，背景对话仍可操作）。
4. 移动 390px：模态抽屉、遮罩隔离背景、Tab 循环、Escape/关闭按钮关闭。
5. 运行时故障时刷新失败：保留既有余额数据并提供重试，重试成功恢复。
6. 空账本呈现空状态与刷新入口；多币种账本各币种分别列示。
7. 卸载插件后入口消失、样式移除。

正式发布仍须在干净 checkout 中另行运行 `npm run release:preflight`，再按发布验收记录完成 registry 与真实宿主验证。全部通过后检查最终差异：确认没有 pnpm 文件、构建生成物或公开契约漂移进入提交。
