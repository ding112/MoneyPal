# MoneyPal 使用指南

[返回产品首页](../README.md)

本文包含 DSH 的安装、日常操作与排障说明，以及 DSH 和 Skill 的账单导入流程。使用其他宿主时，请先从[产品首页的使用方式](../README.md#start)进入对应接入指南。

## 在 DSH 中开始使用

已有 DSH Web（0.2.1-rc.2 或更新版本）后，只需三步：

**1. 安装插件**

```bash
dsh plugin --profile web add dsh-moneypal
```

**2. 打开 MoneyPal 会话**

选择准备保存账本的文件夹作为工作区，在新会话中选择 **MoneyPal** 预设。如果宿主提示需要重启，按提示重启后再继续。

**3. 让助手完成首次准备**

把下面这句话发给助手：

> 帮我开始使用 MoneyPal：检查并按需准备运行环境，使用当前工作区的账本；如果还没有账本，先展示初始化内容，等我确认后创建。最后检查账本并查询一次余额。

DSH 可以代你执行环境检查与准备，并通过原生确认框创建新账本；已有账本会直接复用。完成首次余额查询后，就可以提供账单文件或直接用自然语言记账。

## 环境要求与手动排查命令

需要 Node.js 22.18+。首次创建托管运行时还需要 Python 3.11+（含 `venv` 和 `pip`），并能下载 Python 依赖；缺少条件时，让助手协助检查和准备。

以下命令可由 DSH 助手执行，也可在终端手动运行。

检查 MoneyPal 运行时：

```bash
dsh plugin --profile web exec dsh-moneypal runtime-status
```

如果状态中的 `available` 和 `compatible` 不是 `true`，准备运行时后再次检查：

```bash
dsh plugin --profile web exec dsh-moneypal setup-runtime
dsh plugin --profile web exec dsh-moneypal runtime-status
```

兼容运行时需要 Python 3.11+、Beancount 3.2.3+ 和 beanquery 0.2.0+。首次引导由助手按需执行准备命令；日常启动和查询不会自动安装或升级运行时。

新账本优先让助手通过 `finance_initialize_ledger` 展示初始化内容，在原生确认框中确认后创建。也可手动初始化，将路径替换为选定的账本工作区：

```bash
dsh plugin --profile web exec dsh-moneypal init /path/to/ledger-workspace
```

两种方式都会拒绝覆盖已存在的 `default/`。已有符合布局的账本无需重新初始化。


## 如何导入账单

完成对应入口的安装与账本准备后，DSH 和 Skill 都可以处理账单导入：

1. 从支付宝、微信或银行导出账单文件。
2. 将文件提供给助手，或告知助手可读取的文件位置。
3. 发送以下导入请求。
4. 核对助手展示的交易明细、账户、收支汇总、写入文件和疑似重复提醒；需要调整时先修改预览。
5. 确认后写入：DSH 在原生确认框中确认；Skill 在对话中回复“确认记账”。
6. 助手写入后查询流水复核，报告实际结果。

> 请导入这份账单，先整理交易并展示记账预览，提示可能重复的记录，等我确认后再写入。

账本文件保存在本地，但账单内容、查询结果和交易信息可能进入宿主配置的模型上下文。

## 日常使用

DSH 插件提供以下工具：

| 工具 | 用途 |
| --- | --- |
| `finance_query_register` | 按账户、文本和日期范围查询流水 |
| `finance_get_balance` | 查询账户余额 |
| `finance_get_income_statement` | 查询期间损益表 |
| `finance_get_balance_sheet` | 查询期末资产负债表 |
| `finance_list_accounts` | 列出账本中声明的账户 |
| `finance_validate_journal` | 校验整个账本 |
| `finance_add_transactions` | 预览交易，经根 Agent 的确认框确认后整批原子写入 |
| `finance_initialize_ledger` | 预览初始化内容，经根 Agent 确认后创建基础账本 |

例如：“列出 2026 年 8 月的餐饮支出”“查看截至 2026-08-31 的资产负债表”或“记一笔 2026-09-07 的午餐 35 元，现金支付”。

日期使用 `YYYY-MM-DD`。DSH Web 可按浏览器时区理解“今天”“昨天”；时间或时区不可用时会要求澄清。报表金额按币种分别展示，不自动换汇。

记账前核对预览中的日期、账户、金额、说明和重复提醒。确认前账本不会改变；取消或关闭确认框不会写入。账本在预览后发生变化时，必须重新预览并确认。若返回 `write_outcome_uncertain`，先查询账本确认结果，再决定是否重试。

## 资产负债概览抽屉

当前账本会话的 `default/main.beancount` 存在时，会话标题栏显示“资产负债概览”入口。抽屉展示截至浏览器本地日期的资产与负债明细；打开且页面可见时每 30 秒刷新，也可手动刷新。金额按商品分别展示，不做汇率换算。

抽屉是只读界面。查询使用当前已挂载会话的工作区；正式记账仍经受确认保护的财务工具完成。

## 账本布局

正式账本位于账本工作区下的 `default/`：

```text
<账本工作区>/default/
├── main.beancount
├── accounts.beancount
└── transactions/
    └── <年份>.beancount
```

`main.beancount` 汇入账户声明和年度交易文件。初始化会创建 CNY 商品和一组基础账户；需要时可按自己的账户结构编辑 `accounts.beancount`。仓库中的 `data/finance/default/` 是演示账本，不会自动用作正式账本。

写入目标为 `transactions/<年份>.beancount`。每批交易在一次确认后原子写入，并在提交前重新校验账本快照。疑似重复交易会提示但不会阻止确认；账本锁不会自动删除。提交结果不确定时必须先查询账本，系统不会自动重试。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| `invalid_ledger_layout` | 检查 `default/main.beancount`、`default/accounts.beancount`、年度交易文件和 include。 |
| `runtime_unavailable` | 运行 `runtime-status` 检查；状态不兼容时显式运行 `setup-runtime`。 |
| 启用失败：`cannot get property "webServer" without inject` | 检查插件版本；旧版本请更新到 1.0.0-rc.16 或更新版本。 |
| 看不到 MoneyPal 预设或抽屉 | 确认 DSH 版本及插件组件运行状态，刷新浏览器，并在新会话中选择 MoneyPal。 |
| `preview_stale` 或预览过期 | 重新查询账本、生成预览并确认。 |
| `ledger_locked` | 确认没有其他写入进程，再按账本维护流程处理遗留锁。 |
| `write_outcome_uncertain` | 先查询正式账本核对是否已写入，不要直接重复提交。 |

### 安装后提示 `webServer` 未注入

该错误可能来自旧版 MoneyPal。请检查实际安装的插件版本并升级到 `1.0.0-rc.16` 或更新版本。如果更新后仍出现错误，记录 DSH 版本、插件版本和启动日志，再排查宿主配置。

## 升级与卸载

升级插件后，在新会话中选择 MoneyPal；如宿主提示需要重启，按提示操作：

```bash
dsh plugin --profile web add dsh-moneypal
```

移除插件 bundle：

```bash
dsh plugin --profile web remove dsh-moneypal
```

插件移除后预设不再出现在新会话中。MoneyPal 运行时不会随插件卸载；旧版遗留的 `.agent-presets/dsh-moneypal` 目录由新版 DSH 忽略，插件不会自动删除。
