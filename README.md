# MoneyPal

MoneyPal 让人通过自然语言查询和维护 Beancount 复式记账账本，同时保留人在正式写入前的最终决定权。仓库从同一份财务核心生成两个相互独立的 npm 包：

| npm 包 | 用途 | 不包含 |
| --- | --- | --- |
| `dsh-moneypal` | DSH Web 财务工具、写入确认和余额抽屉 | MCP 服务器和领域技能 |
| `mcp-moneypal` | WorkBuddy 等宿主使用的 MCP stdio 服务器和领域技能 | DSH 插件、预设和浏览器代码 |

两个包都只从宿主指定的**账本工作区**读取或校验正式账本；不会保存、询问或搜索账本目录。仓库本身不是你的正式账本。

## 前置条件

- Node.js 22.18 或更高版本（本地从源码安装时需要）
- 可用的 MoneyPal 运行时（含 Beancount 3.2+ 与 beanquery 0.2+；详见下方初始化与运行时）
- DSH Web，以及可用的 Web profile
- 一个准备在 DSH Web 中打开的本地账本工作区

## 安装

本地开发安装：

```bash
npm install
npm run build
dsh plugin --profile web add /path/to/moneypal-workspace/dist/packages/dsh-moneypal
dsh plugin --profile web exec dsh-moneypal install-preset
```

安装包会向 Web profile 的全局 bundle 注册只读余额适配器；`install-preset` 仍只生成 Agent 作用域的七个财务工具。升级插件、升级 DSH 或移动本地包后，先重新安装插件、再重新生成托管预设；随后重启 DSH Web，并在浏览器执行一次硬刷新以加载新的客户端抽屉。

## 开发验证

日常开发运行 `npm run test:fast`；针对单个改动可先构建，再运行对应的 `dist/test/*.test.js`。合并前运行 `npm test`。涉及插件入口、公开 Schema、宿主注册、运行时依赖或发布流程时，运行 `npm run test:release`；它复用一次构建完成全量测试、包检查和 tarball 隔离安装验收。

npm 发布后的 DSH 安装：

```bash
dsh plugin --profile web add dsh-moneypal
dsh plugin --profile web exec dsh-moneypal install-preset
```

在 DSH Web 中打开账本工作区，并选择生成的 `dsh-moneypal` 托管预设。安装器从当前 DSH Web 的 `standard` 预设重新生成该预设；升级 DSH、升级插件或移动本地包后，都应再次运行 `install-preset`。

## 发布

根 `package.json` 标记为 `private`，直接在仓库根目录执行 `npm publish` 会被拒绝。先检查两个独立包，再按需分别发布：

```bash
npm run pack:check
npm run publish:dsh
npm run publish:mcp
```

两个发布命令互不隐含对方；只运行其中一个，就只上传对应的 npm 包。

卸载需要分别移除插件和托管预设。先关闭 DSH Web，再运行：

```bash
dsh plugin --profile web remove dsh-moneypal
```

这条命令只移除 Web profile 中的 npm 包，不会删除安装器生成的预设目录。确认 `agent.cordis.yml` 中包含 `# dsh-moneypal-managed: true` 后，在 Finder 中将默认位置的 `/Users/ding/.dsh/.agent-presets/dsh-moneypal` 移到废纸篓；如果使用了自定义 `DSH_HOME`，则在其 `.agent-presets/dsh-moneypal` 下执行同样操作。重启 DSH Web 后，该预设不应再出现。

`dsh-moneypal` 命令提供预设安装和账本初始化，不提供账本查询或写入命令。

## 初始化账本工作区

在要打开给 DSH Web 的账本工作区中执行：

```bash
dsh plugin --profile web exec dsh-moneypal init
```

也可以显式指定要创建的账本工作区：

```bash
dsh plugin --profile web exec dsh-moneypal init /path/to/ledger-workspace
```

命令会创建 CNY 商品和 `Assets:C-现金`、`Liabilities:C-信用卡`、`Equity:C-期初余额`、`Expenses:C-餐饮`、`Income:C-工资` 等起始账户，并创建当前年度交易文件。随后可按自己的账户结构编辑 `default/accounts.beancount`；中文开头的账户段必须使用字面 `C-` 前缀。如果 `default/` 已存在，命令会拒绝执行且不会覆盖已有账本。

在 DSH Web 中，根 Agent 也可调用 `finance_initialize_ledger` 初始化当前挂载的工作区。工具会展示将创建的账户和文件，并在你确认后才写入；子 Agent 无权调用，已有 `default/` 时不会提示确认且不会覆盖。该工具自动采用 DSH 服务器本地年份；MCP 不提供此工具，仍请使用上方 CLI 命令初始化。

固定布局如下；至少创建一个年度文件（例如 `2026.beancount`）很重要：当通配符没有匹配任何文件时，账本加载会失败。缺少目录、文件或 include 无效时，工具返回结构化错误，不会自动修复：

```text
<账本工作区>/default/
├── main.beancount
├── accounts.beancount
└── transactions/
    └── <当前年份>.beancount
```

写入目标固定为 `transactions/<年份>.beancount`，新年度文件由确认后的写入以 `0600` 权限原子创建。

MoneyPal 运行时需要显式执行一次 `setup-runtime` 安装或升级；日常操作优先使用共享托管环境，也可用 `MONEYPAL_PYTHON` 覆盖解释器路径。任何安装、启动、初始化或查询都不会静默改变运行时。

仓库中的 `data/finance/default/` 是演示账本，布局相同，但 DSH 不会自动把它选作正式账本。

## 财务工具

所有日期均为合法的 `YYYY-MM-DD`。预设会从本次 DSH Web 请求的浏览器时区采样当前时间；用户未指定年份时，Agent 使用该时间的当前年份，并据此解释“今天”“昨天”等相对日期。时间或时区不可用时，Agent 会要求澄清，而不会猜测日期。提供 `begin` 和 `end` 时，`begin` 含、`end` 不含：例如 `begin=2026-01-01`、`end=2026-02-01` 包含一月，不包含二月一日。损益表只按 Beancount 的 Income 与 Expenses 账户分类；资产负债表按期末 Assets、Liabilities 与 Equity 账户分类，并保留期初、收益与转换权益账户使两侧可核验；报表金额按商品分别保留，不做汇率换算或隐式估值。

| 工具 | 用途 | 权限 | 典型说法 |
| --- | --- | --- | --- |
| `finance_query_register` | 按账户、文本、日期区间查询流水，可用数量限制截断 | 根、子 Agent | “列出 8 月餐饮支出” |
| `finance_get_balance` | 按账户和日期区间查询余额 | 根、子 Agent | “截至今天现金余额是多少？” |
| `finance_get_income_statement` | 查询期间损益表（Income/Expenses 账户，begin 含、end 不含） | 根、子 Agent | “生成 2026 年 1 月损益表” |
| `finance_get_balance_sheet` | 查询期末资产负债表（Assets/Liabilities/Equity 账户，含期初与收益权益账户） | 根、子 Agent | “查看 6 月底资产负债表” |
| `finance_list_accounts` | 返回已声明账户名称 | 根、子 Agent | “账本里有哪些可用账户？” |
| `finance_validate_journal` | 校验整个正式账本 | 根、子 Agent | “检查账本是否有效” |
| `finance_add_transactions` | 预览、确认并整批原子写入同年普通交易；预览文本与最终写入字节完全一致 | 仅根 Agent | “记一笔今天的午餐 35 元，现金支付” |

子 Agent 可以进行所有只读分析，但不能调用写入工具；它应把候选交易或报告交回根 Agent，再由根 Agent 完成唯一一次交互式确认。

## 账户余额抽屉

当当前账本会话的 `default/main.beancount` 存在时，会话标题栏出现“余额”入口。抽屉覆盖在右侧（窄屏占满宽度），默认展示截至浏览器本地今天的 Assets 与 Liabilities 明细，并在打开且页面可见时每 30 秒刷新一次；可随时手动刷新。未来日期交易不计入，金额按商品分别展示和汇总，不做汇率换算。资产保留账本符号；负债会取反显示，因此通常的欠款为正数，已多还的余额仍为负数。

抽屉只在页面内存保存账户名、金额、时间和错误；浏览器持久化的只有全局开关偏好。读取请求通过 DSH Connection 的 loopback 通道完成，客户端不能传入账本路径，宿主只读取当前已挂载会话的工作区。全局适配器没有写入能力；记账仍只能经根 Agent 的确认保护财务工具完成。

## 在 WorkBuddy 中使用

`mcp-moneypal` 把同一套财务工具通过 MCP stdio 暴露给 WorkBuddy 等 MCP 宿主。账本工作区由宿主配置的环境变量指定，任何工具调用都不能传入路径，因此每个正式账本注册一个服务器条目。

前置条件：可用的 MoneyPal 运行时与 Node.js 22.18+。先安装独立的 MCP 包：

```bash
npm install -g mcp-moneypal
```

在 WorkBuddy 的用户级或项目级 `mcp.json` 中加入：

```json
{
  "mcpServers": {
    "moneypal": {
      "command": "mcp-moneypal",
      "env": {
        "MONEYPAL_LEDGER_WORKSPACE": "/path/to/ledger-workspace"
      }
    }
  }
}
```

从本仓库本地开发时，可把 `command` 改为 `node`，并将 `args` 设为 `["/path/to/moneypal-workspace/dist/packages/mcp-moneypal/dist/src/mcp-main.js"]`。

环境变量说明：

- `MONEYPAL_LEDGER_WORKSPACE`（必填）：账本工作区，须包含 `default/main.beancount`、`default/accounts.beancount` 和 `default/transactions/`。有多个账本时注册多个 `mcpServers` 条目，各自指向不同工作区。
- `MONEYPAL_PYTHON`（可选）：解释器的绝对路径；缺省使用共享托管运行时。
- `MONEYPAL_BATCH_TTL_MS`（可选）：写入预览批次的有效期（毫秒），默认 30 分钟；仅供测试调整。

配置后重启 WorkBuddy 即可。六个只读工具与 DSH 完全一致；每个成功的工具响应都带 `serverToday`（服务器本机时区当日），可与对话中的日期互相核对。工具描述要求所有日期参数使用绝对日期 YYYY-MM-DD；请直接给出绝对日期，避免“昨天”等相对表述被错误换算。余额以工具 JSON 输出呈现，余额抽屉保持 DSH Web 专属。

### WorkBuddy 专家包：恰恰账本

仓库还可生成可上传到 WorkBuddy 专家市场的“恰恰账本”专家包。它内置 `mcp-moneypal` 命令声明和同一份 MoneyPal 领域技能，但不会包含账本路径、账本内容、Token 或其他本机配置：导入前仍须按上方示例在 WorkBuddy MCP 配置中设置 `MONEYPAL_LEDGER_WORKSPACE`。

执行 `npm run build` 后，上传 `dist/experts/moneypal.zip`。ZIP 解压后的顶层目录为 `moneypal/`，包含专家定义、头像、MCP 声明和领域技能；市场审核与最终发布由维护者在 WorkBuddy 网页完成。

### 领域技能（可选）

仓库附带 `skills/mcp-moneypal/SKILL.md`：提供领域规则和启动检查，不实现财务工具本身。装上它，助手在解释“今天/昨天”、组织写入确认对话和恢复批次错误时更稳；不装也不影响工具本身可用。

技能还包含首次启动检查：MCP 工具缺失或 MoneyPal 运行时不可用时，它会区分“未安装”和“已安装但宿主未配置”，并在取得用户对机器级变更的授权后自动安装、复验缺少的软件。

安装：把 `skills/mcp-moneypal/` 整个目录复制进 WorkBuddy 的技能目录（位置以 WorkBuddy 文档为准）。全局安装后，也可从 `<npm root -g>/mcp-moneypal/skills/mcp-moneypal/` 复制。技能与工具契约各自独立，升级包后如技能有更新，重新复制一次即可。

### 写入使用协议

MCP 下没有 DSH 的确认对话框，写入拆成两个工具、由你的对话确认连接起来：

1. 让助手调用 `finance_preview_transactions`（入参与 DSH 写入工具一致）。它返回批次号、过期时间、目标年度交易文件 `transactions/<year>.beancount` 及是否新建、按币种的收支汇总、与最终写入字节完全一致的规范交易文本和重复警告；此时账本没有任何变化。
2. 你在对话中查看预览并明确确认（或要求修改）。未经你的确认，助手不得调用 commit。
3. 确认后助手调用 `finance_commit_transactions` 并传入批次号，批次被一次性消费并整批原子写入目标年度交易文件。

安全底线与 DSH 一致：批次默认 30 分钟过期，过期后必须重新生成预览；待写入批次至多 3 个，超出挤出最旧；预览后账本有任何变化，commit 会以 `preview_stale` 拒绝；跨进程并发写入由 `default/.moneypal-write.lock` 账本锁互斥，遗留锁不会被自动删除；未声明账户在预览阶段即被拒绝；发布结果无法确认时返回 `write_outcome_uncertain`，必须先查询正式账本再决定是否重试，绝不自动重试。

常见故障排查：

- 工具返回 `invalid_workspace`：`MONEYPAL_LEDGER_WORKSPACE` 未设置或为空。在 mcp.json 的 env 中补上后重启 WorkBuddy。
- 工具返回 `invalid_ledger_layout`：工作区缺少 `default/main.beancount`、`default/accounts.beancount` 或年度交易文件。运行 `mcp-moneypal init /path/to/ledger-workspace`，或对照上方固定布局修复。
- 工具返回 `runtime_unavailable`：MoneyPal 运行时不可用。执行 `setup-runtime`，或在 env 中用 `MONEYPAL_PYTHON` 指定解释器绝对路径。
- 服务器无法启动：确认全局命令 `mcp-moneypal` 可用；从源码运行时先执行 `npm run build`，再确认 MCP 发布目录中的 `dist/src/mcp-main.js` 存在。

## 写入与恢复

写入工具把整份候选交易交给 Beancount 官方流程解析、booking 与强化校验，由官方 printer 生成规范文本，再以计划审阅卡片显示完整交易及按币种的收入、支出和净额；内部转账不计入收支汇总。整份提交经一次确认后 all-or-nothing 原子写入，不按数量切分。预览中的规范文本与最终写入字节完全一致，写入后整个账本仍可通过 Beancount 重新加载验证。只有发现疑似重复交易时才会额外提醒（候选日期前后各 3 天，比较正式账本与同批较早候选，提醒不阻止确认）。预览只供确认，若需修改可返回对话后重新生成候选。

审阅卡片不会因工具调用超时自动关闭；等待确认期间不持有账本锁。确认后提交会持有 `default/.moneypal-write.lock` 跨进程锁，重新校验规范文本并重算账本快照；账本发生变化时拒绝写入并要求重新预览。

- 人在确认框选择取消或关闭确认框：正式账本零变化。
- 疑似重复是确定性提醒，不会阻止确认，也不是严格幂等保证。
- 确认后如果已加载的账本文件、include 文件集合或目标新年度文件发生变化，写入会因预览过期而拒绝；重新查询并重新确认。
- 同一账本已有写入锁时，返回 `ledger_locked`；遗留锁不会被自动删除，确认无其他写入进程后请通过账本维护处理。
- 提交在目标目录同文件系统创建临时文件并同步，再以原子替换（已有年度文件）或原子 no-clobber（新年度文件）发布；发布成功后同步父目录。
- 原子发布开始后无法再报告安全取消：发布或持久化状态无法确认时返回 `write_outcome_uncertain`，正式账本可能已写入，此时先查询账本确认范围，再决定是否重试；不要直接重复提交，系统也不会自动重试。
- 发布已明确成功后，仅临时文件或遗留锁清理的失败不影响正式内容，仍返回成功并附带净化后的警告；遗留锁会阻止下一次写入。

## 开发者文档

DSH/MCP 插件的开发规范（依赖边界、服务访问、注册语义、工具契约、错误边界、验证流程）见 [docs/agents/dsh-plugin-development.md](docs/agents/dsh-plugin-development.md)。

## 维护边界与隐私

日常查询和记账应使用上述财务工具。账户声明、账本布局、高级 Beancount 语法、锁文件排查和异常恢复属于明确的账本维护，可以使用标准 Bash 或文件工具。这些标准工具是维护通道，财务工具的约束并不构成强安全沙箱。

账本文件保存在本地并不表示财务数据永不离开本机。为了理解查询、生成候选交易和显示确认，账户名、描述、日期、金额及查询结果可能进入当前 DSH 所配置模型的上下文。请根据模型提供商和 DSH 配置评估数据处理风险。

v1 不执行 Git 检查、暂存或提交；如需版本管理，请由人使用自己的 Git 工作流处理。
