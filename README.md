# MoneyPal

通过自然语言查询和维护本地 Beancount 复式记账账本：查余额、看流水、生成报表，或描述一笔收支，在审阅并确认后完成记账。

这份 README 按“安装 → 连接账本 → 首次查询 → 日常记账”组织。先选择你的使用入口，完成对应的快速开始即可；开发和发布说明放在末尾。

| 使用入口 | 安装包 | 提供的能力 |
| --- | --- | --- |
| DSH Web | `dsh-moneypal` | 财务工具、写入确认框和账户余额抽屉 |
| WorkBuddy 等 MCP 宿主 | `mcp-moneypal` | MCP stdio 财务工具和可选领域技能，通过对话确认写入 |

两个包独立安装。下方命令使用默认发布版本；如需安装当前发布脚本对应的 `next` 预发布版本，将安装命令中的包名替换为 `dsh-moneypal@next` 或 `mcp-moneypal@next`。

正式账本保存在宿主指定的**账本工作区**，仓库本身不是你的正式账本；财务工具不会保存、询问或搜索账本目录。

## 导航

- [DSH Web 快速开始](#dsh-web-快速开始)
- [WorkBuddy 与 MCP 快速开始](#workbuddy-与-mcp-快速开始)
- [日常使用](#日常使用)
- [账户余额抽屉](#账户余额抽屉)
- [领域技能（可选）](#领域技能可选)
- [常见问题](#常见问题)
- [升级与卸载](#升级与卸载)
- [进阶参考](#进阶参考)
- [开发与发布](#开发与发布)

## DSH Web 快速开始

### 1. 准备环境并安装插件

需要 Node.js 22.18+、可用的 DSH Web 和 Web profile，以及一个用于保存账本的本地目录。首次创建托管运行时还需要 Python 3.11+（支持 `venv` 和 `pip`），并能下载 Python 依赖。

```bash
dsh plugin --profile web add dsh-moneypal
dsh plugin --profile web exec dsh-moneypal install-preset
```

在 `dsh-market` 中点击 MoneyPal 卡片安装时，安装的是 npm 已发布包 `dsh-moneypal`，版本跟随 registry 的 `latest` 标签，不一定是仓库当前源码版本。仓库里的 `packages/dsh-moneypal/` 目录供市场目录发现包名与补丁，不是可直接安装的已构建目录。

### 2. 准备并检查运行时

```bash
dsh plugin --profile web exec dsh-moneypal setup-runtime
dsh plugin --profile web exec dsh-moneypal runtime-status
```

检查输出 JSON 中的 `available` 和 `compatible` 都为 `true`，表示运行时可用且版本兼容。运行时需要 Python 3.11+、Beancount 3.2.3+ 和 beanquery 0.2.0+。

`setup-runtime` 显式安装共享托管环境；日常启动、初始化和查询不会自动安装或升级运行时。已有可用运行时可直接检查并跳过安装。自定义解释器见[运行时配置](#运行时配置)。

### 3. 初始化新账本

将示例路径替换成你的账本目录：

```bash
dsh plugin --profile web exec dsh-moneypal init /path/to/ledger-workspace
```

也可进入账本目录后执行不带路径的 `init`。**已有符合布局的账本无需重新初始化**；如果 `default/` 已存在，命令会拒绝执行，不会覆盖。文件结构和起始账户见[账本布局与初始化](#账本布局与初始化)。

### 4. 打开账本并首次查询

重启 DSH Web，在浏览器执行一次硬刷新；打开上一步的账本工作区，选择生成的 `dsh-moneypal` 托管预设。安装器以当前 DSH Web 的 `standard` 预设为基础生成该预设。

向助手发送：

> 账本里有哪些可用账户？然后检查账本是否有效。

助手能列出账户并通过账本校验，就可以开始查询和记账。新账本尚无交易，余额为空或为零是正常的。

## WorkBuddy 与 MCP 快速开始

### 1. 准备环境并安装 MCP 包

需要 Node.js 22.18+、支持 MCP stdio 的宿主和本地账本目录。首次创建托管运行时还需要 Python 3.11+（支持 `venv` 和 `pip`），并能下载 Python 依赖。这条路径不需要安装 DSH。

```bash
npm install -g mcp-moneypal
```

### 2. 准备并检查运行时

```bash
mcp-moneypal setup-runtime
mcp-moneypal runtime-status
```

检查输出 JSON 中的 `available` 和 `compatible` 都为 `true`。运行时需要 Python 3.11+、Beancount 3.2.3+ 和 beanquery 0.2.0+；已准备好的共享运行时可直接使用。自定义解释器见[运行时配置](#运行时配置)。

### 3. 初始化新账本

```bash
mcp-moneypal init /path/to/ledger-workspace
```

**已有符合布局的账本无需重新初始化**。如果 `default/` 已存在，命令会拒绝执行，不会覆盖；已有目录不完整时请按[账本布局](#账本布局与初始化)检查修复。

### 4. 配置宿主并首次查询

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

环境变量说明：

- `MONEYPAL_LEDGER_WORKSPACE`（必填）：账本工作区，须包含 `default/main.beancount`、`default/accounts.beancount` 和 `default/transactions/`。有多个账本时注册多个 `mcpServers` 条目，各自指向不同工作区。
- `MONEYPAL_PYTHON`（可选）：解释器的绝对路径；缺省使用共享托管运行时。
- `MONEYPAL_BATCH_TTL_MS`（可选）：写入预览批次的有效期（毫秒），默认 30 分钟；仅供测试调整。

配置后重启 WorkBuddy 即可。六个只读工具与 DSH 完全一致；每个成功的工具响应都带 `serverToday`（服务器本机时区当日），可与对话中的日期互相核对。工具描述要求所有日期参数使用绝对日期 YYYY-MM-DD；请直接给出绝对日期，避免“昨天”等相对表述被错误换算。余额以工具 JSON 输出呈现，余额抽屉保持 DSH Web 专属。

向助手发送：

> 账本里有哪些可用账户？然后检查账本是否有效。

能列出账户并通过校验，即表示宿主已连接账本。随后可按[日常使用](#日常使用)操作；需要助手遵循领域规则时，可安装[可选领域技能](#领域技能可选)。

## 日常使用

### 查询账户、流水与报表

直接描述需要的信息。以下明确日期的示例适用于两种宿主，请将日期、账户和金额替换为自己的实际情况。

| 想做什么 | 可以这样说 |
| --- | --- |
| 查账户 | “账本里有哪些可用账户？” |
| 查余额 | “截至 2026-09-07，现金账户余额是多少？” |
| 查流水 | “列出 2026 年 8 月的餐饮支出。” |
| 查损益 | “生成 2026 年 8 月损益表。” |
| 查资产负债 | “查看截至 2026-08-31 的资产负债表。” |
| 检查账本 | “检查账本是否有效。” |

DSH Web 支持按浏览器时区理解“今天”“昨天”；时间或时区不可用时会要求澄清。MCP 使用时请直接给出绝对日期，避免宿主错误换算相对日期。报表金额按币种或商品分别展示，不自动换汇。

### 记一笔交易

1. **提出需求**：例如“记一笔 2026-09-07 的午餐 35 元，现金支付”。账户必须已在账本中声明；可先让助手列出账户。
2. **查看预览**：核对日期、账户、金额、说明及重复提醒。此时账本尚未变化。
3. **确认或修改**：DSH Web 会显示确认框，确认后才写入，取消或关闭则不写入；MCP 会在对话中展示预览，只有你明确确认后，助手才应提交。需要修改时，让助手重新生成预览再确认。
4. **核对结果**：写入成功后，可以说“列出 2026-09-07 的午餐交易”，检查正式账本中的记录。

预览后账本发生变化或批次已过期，需要重新预览并确认。如果提示 `write_outcome_uncertain`，先查询正式账本确认是否已写入，再决定是否重试，**不要直接重复提交**。更多情况见[常见问题](#常见问题)。

## 账户余额抽屉

当当前账本会话的 `default/main.beancount` 存在时，会话标题栏出现“余额”入口。抽屉覆盖在右侧（窄屏占满宽度），默认展示截至浏览器本地今天的 Assets 与 Liabilities 明细，并在打开且页面可见时每 30 秒刷新一次；可随时手动刷新。未来日期交易不计入，金额按商品分别展示和汇总，不做汇率换算。资产保留账本符号；负债会取反显示，因此通常的欠款为正数，已多还的余额仍为负数。

抽屉只在页面内存保存账户名、金额、时间和错误；浏览器持久化的只有全局开关偏好。读取请求通过 DSH Connection 的 loopback 通道完成，客户端不能传入账本路径，宿主只读取当前已挂载会话的工作区。全局适配器没有写入能力；记账仍只能经根 Agent 的确认保护财务工具完成。

## 领域技能（可选）

仓库附带 `skills/mcp-moneypal/SKILL.md`：提供领域规则和启动检查，不实现财务工具本身。装上它，助手在解释“今天/昨天”、组织写入确认对话和恢复批次错误时更稳；不装也不影响工具本身可用。

技能还包含首次启动检查：MCP 工具缺失或 MoneyPal 运行时不可用时，它会区分“未安装”和“已安装但宿主未配置”，并在取得用户对机器级变更的授权后自动安装、复验缺少的软件。

安装：把 `skills/mcp-moneypal/` 整个目录复制进 WorkBuddy 的技能目录（位置以 WorkBuddy 文档为准）。全局安装后，也可从 `<npm root -g>/mcp-moneypal/skills/mcp-moneypal/` 复制。技能与工具契约各自独立，升级包后如技能有更新，重新复制一次即可。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| `invalid_workspace` | MCP：检查 `mcp.json` 的 `env` 是否设置了非空的 `MONEYPAL_LEDGER_WORKSPACE`，修改后重启宿主。 |
| `invalid_ledger_layout` | 检查当前工作区的 `default/main.beancount`、`default/accounts.beancount`、年度交易文件及 include。新账本用对应快速开始中的 `init`；已有 `default/` 时按布局修复，不要反复初始化。 |
| `runtime_unavailable` | 执行对应入口的 `runtime-status` 检查，缺少运行时则执行 `setup-runtime`；运行时正在安装或使用时稍后重试。使用 `MONEYPAL_PYTHON` 时检查该解释器的路径和依赖。 |
| MCP 服务器无法启动 | 确认宿主能找到全局命令 `mcp-moneypal`；源码方式先构建，再检查配置的入口路径。 |
| DSH 看不到预设或抽屉未更新 | 重新安装插件并运行 `install-preset`，重启 DSH Web、硬刷新浏览器，确认已选择预设并打开账本工作区。 |
| `preview_stale` 或预览批次过期 | 重新查询账本、生成预览，并再次确认后提交。 |
| `ledger_locked` | 检查是否有其他写入进程；确认没有后按账本维护流程排查遗留锁，工具不会自动删除账本锁。 |
| `write_outcome_uncertain` | 正式账本可能已写入。先查询核对，再决定是否重试；系统不会自动重试。 |

## 升级与卸载

### DSH Web

升级插件、升级 DSH 或移动本地包后，先重新安装插件，再重新生成托管预设；随后重启 DSH Web 并硬刷新浏览器：

```bash
dsh plugin --profile web add dsh-moneypal
dsh plugin --profile web exec dsh-moneypal install-preset
```

卸载时先关闭 DSH Web，再按顺序运行：

```bash
dsh plugin --profile web exec dsh-moneypal uninstall-preset
dsh plugin --profile web remove dsh-moneypal
```

第一条命令只删除本插件生成的托管预设：执行前确认目录内的 `agent.cordis.yml` 含 `# dsh-moneypal-managed: true`，缺少标记时拒绝删除并提示人工处理；重复执行安全，预设不存在时只提示无需卸载。默认位置是 `~/.dsh/.agent-presets/dsh-moneypal`，设置了自定义 `DSH_HOME` 时使用其下的 `.agent-presets/dsh-moneypal`。第二条命令移除 Web profile 中的 npm 包；必须按此顺序执行，因为卸载命令本身来自该插件。重启 DSH Web 后预设不应再出现。共享 MoneyPal 运行时不会自动删除，需要清理时单独处理。

如果插件包已被移除、无法再执行 `uninstall-preset`，请手动确认预设目录内的 `agent.cordis.yml` 包含上述标记后，删除 `<DSH_HOME>/.agent-presets/dsh-moneypal`（默认 `~/.dsh/.agent-presets/dsh-moneypal`）。

### WorkBuddy 与 MCP

重新运行 `npm install -g mcp-moneypal` 安装更新，并重启宿主。若领域技能有更新，需要重新复制技能目录。

卸载时从宿主配置中移除对应的 `mcpServers` 条目，执行 `npm uninstall -g mcp-moneypal`，并重启宿主；手动复制的领域技能也需单独移除。

### 更新共享运行时

按使用入口执行其中一组命令：

```bash
# DSH Web
dsh plugin --profile web exec dsh-moneypal setup-runtime --upgrade
dsh plugin --profile web exec dsh-moneypal runtime-status

# MCP
mcp-moneypal setup-runtime --upgrade
mcp-moneypal runtime-status
```

包升级不会静默升级运行时。两个入口共用托管运行时，更新一次即可。

## 进阶参考

### 账本布局与初始化

`init` 命令会创建 CNY 商品和 `Assets:C-现金`、`Liabilities:C-信用卡`、`Equity:C-期初余额`、`Expenses:C-餐饮`、`Income:C-工资` 等起始账户，并创建当前年度交易文件。随后可按自己的账户结构编辑 `default/accounts.beancount`；中文开头的账户段必须使用字面 `C-` 前缀。如果 `default/` 已存在，命令会拒绝执行且不会覆盖已有账本。

在 DSH Web 中，根 Agent 也可调用 `finance_initialize_ledger` 初始化当前挂载的工作区。工具会展示将创建的账户和文件，并在你确认后才写入；子 Agent 无权调用，已有 `default/` 时不会提示确认且不会覆盖。该工具自动采用 DSH 服务器本地年份；MCP 不提供此工具，请使用 `mcp-moneypal init /path/to/ledger-workspace` 初始化。

固定布局如下；至少创建一个年度文件（例如 `2026.beancount`）很重要：当通配符没有匹配任何文件时，账本加载会失败。缺少目录、文件或 include 无效时，工具返回结构化错误，不会自动修复：

```text
<账本工作区>/default/
├── main.beancount
├── accounts.beancount
└── transactions/
    └── <当前年份>.beancount
```

写入目标固定为 `transactions/<年份>.beancount`，新年度文件由确认后的写入以 `0600` 权限原子创建。

仓库中的 `data/finance/default/` 是演示账本，布局相同，但宿主不会自动把它选作正式账本。

### 运行时配置

默认使用 MoneyPal 的共享托管运行时。首次创建时，macOS/Linux 使用 `python3`，Windows 使用 `py` 作为引导解释器；需要指定其他 Python 3.11+ 时，可在对应的 `setup-runtime` 命令后追加 `--python /absolute/path/to/python`。

`MONEYPAL_PYTHON` 可指定外部解释器的绝对路径，须具备兼容版本的 Beancount 和 beanquery；确保宿主进程也能读取该变量。设置此变量后，`setup-runtime` 会拒绝修改外部环境：要使用托管环境，请先取消该变量；要使用外部环境，请自行准备依赖并通过 `runtime-status` 检查。

DSH CLI 提供预设安装、账本初始化、运行时安装和状态检查；MCP CLI 提供账本初始化、运行时安装和状态检查，无子命令时启动 stdio 服务器。两者均不提供直接查询或写入账本的 CLI 子命令，日常使用通过宿主内的财务工具完成。

### 财务工具与日期约定

以下为 DSH 托管预设中的七个日常财务工具；DSH 另提供账本初始化工具 `finance_initialize_ledger`。MCP 复用六个只读工具，将写入拆成预览和提交两个工具。

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

### MCP 写入协议

MCP 下没有 DSH 的确认对话框，写入拆成两个工具、由你的对话确认连接起来：

1. 让助手调用 `finance_preview_transactions`（入参与 DSH 写入工具一致）。它返回批次号、过期时间、目标年度交易文件 `transactions/<year>.beancount` 及是否新建、按币种的收支汇总、与最终写入字节完全一致的规范交易文本和重复警告；此时账本没有任何变化。
2. 你在对话中查看预览并明确确认（或要求修改）。未经你的确认，助手不得调用 commit。
3. 确认后助手调用 `finance_commit_transactions` 并传入批次号，批次被一次性消费并整批原子写入目标年度交易文件。

安全底线与 DSH 一致：批次默认 30 分钟过期，过期后必须重新生成预览；待写入批次至多 3 个，超出挤出最旧；预览后账本有任何变化，commit 会以 `preview_stale` 拒绝；跨进程并发写入由 `default/.moneypal-write.lock` 账本锁互斥，遗留锁不会被自动删除；未声明账户在预览阶段即被拒绝；发布结果无法确认时返回 `write_outcome_uncertain`，必须先查询正式账本再决定是否重试，绝不自动重试。

### 写入与恢复机制

写入工具把整份候选交易交给 Beancount 官方流程解析、booking 与强化校验，由官方 printer 生成规范文本，再以计划审阅卡片显示完整交易及按币种的收入、支出和净额；内部转账不计入收支汇总。整份提交经一次确认后 all-or-nothing 原子写入，不按数量切分。预览中的规范文本与最终写入字节完全一致，写入后整个账本仍可通过 Beancount 重新加载验证。只有发现疑似重复交易时才会额外提醒（候选日期前后各 3 天，比较正式账本与同批较早候选，提醒不阻止确认）。预览只供确认，若需修改可返回对话后重新生成候选。

审阅卡片不会因工具调用超时自动关闭；等待确认期间不持有账本锁。确认后提交会持有 `default/.moneypal-write.lock` 跨进程锁，重新校验规范文本并重算账本快照；账本发生变化时拒绝写入并要求重新预览。

- 人在确认框选择取消或关闭确认框：正式账本零变化。
- 疑似重复是确定性提醒，不会阻止确认，也不是严格幂等保证。
- 确认后如果已加载的账本文件、include 文件集合或目标新年度文件发生变化，写入会因预览过期而拒绝；重新查询并重新确认。
- 同一账本已有写入锁时，返回 `ledger_locked`；遗留锁不会被自动删除，确认无其他写入进程后请通过账本维护处理。
- 提交在目标目录同文件系统创建临时文件并同步，再以原子替换（已有年度文件）或原子 no-clobber（新年度文件）发布；发布成功后同步父目录。
- 原子发布开始后无法再报告安全取消：发布或持久化状态无法确认时返回 `write_outcome_uncertain`，正式账本可能已写入，此时先查询账本确认范围，再决定是否重试；不要直接重复提交，系统也不会自动重试。
- 发布已明确成功后，仅临时文件或遗留锁清理的失败不影响正式内容，仍返回成功并附带净化后的警告；遗留锁会阻止下一次写入。

### 维护边界与隐私

日常查询和记账应使用上述财务工具。账户声明、账本布局、高级 Beancount 语法、锁文件排查和异常恢复属于明确的账本维护，可以使用标准 Bash 或文件工具。这些标准工具是维护通道，财务工具的约束并不构成强安全沙箱。

账本文件保存在本地并不表示财务数据永不离开本机。为了理解查询、生成候选交易和显示确认，账户名、描述、日期、金额及查询结果可能进入当前宿主所配置模型的上下文。请根据模型提供商和宿主配置评估数据处理风险。

v1 不执行 Git 检查、暂存或提交；如需版本管理，请由人使用自己的 Git 工作流处理。

## 开发与发布

### 从源码安装

在仓库根目录执行：

```bash
npm install
npm run build
dsh plugin --profile web add /path/to/moneypal-workspace/dist/packages/dsh-moneypal
dsh plugin --profile web exec dsh-moneypal install-preset
```

安装包会向 Web profile 的全局 bundle 注册只读余额适配器；`install-preset` 生成 Agent 作用域的财务工具预设。随后按 DSH 快速开始准备运行时、连接账本。

本地源码安装必须先构建，再安装构建产物目录 `dist/packages/dsh-moneypal`；仓库里的 `packages/dsh-moneypal/` 只是清单与补丁源，直接安装它不会得到可运行入口。

本地开发 MCP 时，在前述宿主配置中把 `command` 改为 `node`，并将 `args` 设为 `["/path/to/moneypal-workspace/dist/packages/mcp-moneypal/dist/src/mcp-main.js"]`。

### 开发验证

- 单次小改动：`npm run build:base` 后运行对应的 `dist/test/<文件>.test.js`。`build:base` 会清空 `dist`，构建产物只对应最后一次源码，修改后不能省略重新编译。
- 阶段性快速验证：`npm run test:fast`；合并前：`npm test`；涉及发布、包入口、Schema、注入、宿主注册、依赖或发布流程的改动：`npm run test:release`。
- `build:base` 清空 `dist` 并生成基础产物；`npm run build` 额外装配两个发布包与专家 ZIP。任何 `:built` 命令要求对应构建刚完成。
- 本地集成允许明确跳过缺失真实运行时的 18 项；发布严格要求真实运行时可用兼容。
- 发布 UI 验收只在发布前通过 ego-browser skill 执行（清单见 DSH 插件开发规范“验证流程”）；日常测试不包含 React/DOM 模拟器或浏览器测试。
- `npm run test:fast`、`npm test`、`npm run test:release` 三个命令相互包含，不要用它们重复验证同一次修改：按所处阶段选择相应的最高层级即可；单独诊断失败文件时不受此限制。

### WorkBuddy 专家包：恰恰账本

仓库还可生成可上传到 WorkBuddy 专家市场的“恰恰账本”专家包。它内置 `mcp-moneypal` 命令声明和同一份 MoneyPal 领域技能，但不会包含账本路径、账本内容、Token 或其他本机配置：导入前仍须按上方示例在 WorkBuddy MCP 配置中设置 `MONEYPAL_LEDGER_WORKSPACE`。

执行 `npm run build` 后，上传 `dist/experts/moneypal.zip`。ZIP 解压后的顶层目录为 `moneypal/`，包含专家定义、头像、MCP 声明和领域技能；市场审核与最终发布由维护者在 WorkBuddy 网页完成。

### npm 发布

仓库从同一份财务核心生成两个独立 npm 包：`dsh-moneypal` 不包含 MCP 服务器和领域技能；`mcp-moneypal` 不包含 DSH 插件、预设和浏览器代码。

根 `package.json` 标记为 `private`，直接在仓库根目录执行 `npm publish` 会被拒绝。常规发布由下方 GitHub Actions 流程完成；本地命令只作备用，两个命令都显式使用 `next` 标签，绝不改动 `latest`：

```bash
npm run pack:check
npm run publish:dsh
npm run publish:mcp
```

两个本地发布命令互不隐含对方；只运行其中一个，就只上传对应的 npm 包。安装预发布版本时，使用 `dsh-moneypal@next` 或 `mcp-moneypal@next` 替换安装命令中的包名。

### GitHub Actions 自动发布

功能 PR 通过 Test 后以 squash 方式合并到 `main`（提交标题取 PR 标题），随后按以下流程发布：

1. Release 工作流在 `main` push 时运行 Release Please，自动维护 Release PR：更新根 `package.json` 版本、`package-lock.json`、`.release-please-manifest.json` 和 `CHANGELOG.md`。这一步不发布任何包。
2. 维护者关闭再重新打开 Release PR 触发 Test。`GITHUB_TOKEN` 创建的 PR 不会触发其他工作流，所以必须人工关闭再打开；机器人更新 PR 后，要对更新后的提交重新执行此操作。
3. Test 通过后合并 Release PR，Release Please 创建 `v<版本号>` tag 和 GitHub Release（RC 标记为 Prerelease）。
4. Release 工作流从该版本 SHA 重新执行 `npm run test:release` 与 `npm run release:preflight`，保留已验收的两个 tgz，并按 DSH、MCP 顺序发布到 npm `next`。工作流结果就是 npm 是否成功的唯一依据。

两个工作流都会先执行 `node dist/src/main.js setup-runtime` 准备 MoneyPal 托管运行时：发布门禁要求真实运行时可用且兼容，缺少运行时的环境会明确失败，而不是跳过用例。

npm 发布使用 OIDC Trusted Publishing，不读取 `NPM_TOKEN`；工作流始终使用 `next` 标签，`latest` 仍由人运行 `npm run release:promote` 提升。

发布失败时用 tag 重试，例如：

```bash
gh workflow run release.yml --ref v1.0.0-rc.4 -f tag=v1.0.0-rc.4
```

手动重试只接受已经存在的 tag 与 GitHub Release，并要求该 tag 的提交在 `main` 历史中、版本与根清单和 manifest 一致。已经存在于 registry 且字节一致的包会安全跳过，因此第二包失败后重试只发布缺失的包。Release Please 只在创建 Release 的那次返回 `release_created=true`，所以不要依赖“重跑旧的 run”恢复发布，统一使用上面的 tag 重试入口。

日常改动由 Test 工作流（`.github/workflows/test.yml`）在 `main` push 与 PR 的 `opened`、`synchronize`、`reopened`、`edited` 事件上运行：校验 PR 标题格式并执行 `npm run test:release`。

首次上线步骤与维护者一次性配置见 [1.0.0 发布验收记录](docs/releases/1.0.0-acceptance.md)。

### 开发者文档

DSH/MCP 插件的开发规范（依赖边界、服务访问、注册语义、工具契约、错误边界、验证流程）见 [DSH 插件开发规范](docs/agents/dsh-plugin-development.md)。
