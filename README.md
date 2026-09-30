# MoneyPal

MoneyPal 是 DSH Web 的本地 Beancount 记账插件。它提供财务查询、账本校验、经人工确认的记账工具，以及资产负债概览抽屉。

## 安装与首次使用

需要 Node.js 22.18+、DSH 0.1.7-rc.2 或更新版本的 Web profile，以及本地账本工作区。首次创建托管运行时还需要 Python 3.11+（含 `venv` 和 `pip`），并能下载 Python 依赖。

```bash
dsh plugin --profile web add dsh-moneypal
dsh plugin --profile web exec dsh-moneypal runtime-status
```

如果运行时状态中的 `available` 和 `compatible` 不是 `true`，显式准备运行时：

```bash
dsh plugin --profile web exec dsh-moneypal setup-runtime
```

兼容运行时需要 Python 3.11+、Beancount 3.2.3+ 和 beanquery 0.2.0+。日常启动和查询不会自动安装或升级运行时。

新账本可通过 CLI 初始化：

```bash
dsh plugin --profile web exec dsh-moneypal init /path/to/ledger-workspace
```

也可在 DSH Web 的 MoneyPal 会话中调用 `finance_initialize_ledger`。两种方式都会拒绝覆盖已存在的 `default/`。已有符合布局的账本无需重新初始化。

重启 DSH Web 并硬刷新浏览器，在打开账本工作区后的新会话中选择 `MoneyPal` 预设。向助手发送“列出账本账户并检查账本是否有效”即可完成首次检查。

## 日常使用

MoneyPal 提供以下工具：

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

当当前账本会话的 `default/main.beancount` 存在时，会话标题栏显示“资产负债概览”入口。抽屉展示截至浏览器本地日期的资产与负债明细；打开且页面可见时每 30 秒刷新，也可手动刷新。金额按商品分别展示，不做汇率换算。

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
| 看不到 MoneyPal 预设或抽屉 | 确认 DSH 版本和插件 bundle，重启 DSH Web、硬刷新浏览器，并在新会话中选择 MoneyPal。 |
| `preview_stale` 或预览过期 | 重新查询账本、生成预览并确认。 |
| `ledger_locked` | 确认没有其他写入进程，再按账本维护流程处理遗留锁。 |
| `write_outcome_uncertain` | 先查询正式账本核对是否已写入，不要直接重复提交。 |

## 升级与卸载

升级插件后重启 DSH Web、硬刷新浏览器，并在新会话中选择 MoneyPal：

```bash
dsh plugin --profile web add dsh-moneypal
```

卸载前关闭 DSH Web，再移除插件 bundle：

```bash
dsh plugin --profile web remove dsh-moneypal
```

插件移除后预设不再出现在新会话中。MoneyPal 运行时不会随插件卸载；旧版遗留的 `.agent-presets/dsh-moneypal` 目录由新版 DSH 忽略，插件不会自动删除。

## 开发与发布

本仓库只构建和发布 `dsh-moneypal`。从源码安装：

```bash
npm ci
npm run build
dsh plugin --profile web add /path/to/MoneyPal/dist/packages/dsh-moneypal
```

`packages/dsh-moneypal/` 是市场发现用清单及补丁源，不是可直接安装的构建目录。

验证命令：

```bash
npm run typecheck
npm run test:fast
npm test
npm run test:release
```

涉及发布的改动使用 `npm run test:release`。该门禁要求真实兼容的 MoneyPal 运行时，并检查实际 tarball、隔离安装和包入口。

根工作区标记为 `private`，不可直接发布。Release 工作流验证版本与 tag，构建并验收单个 DSH tarball，再通过 npm OIDC Trusted Publishing 发布到 `next`。稳定版的 `latest` 提升由维护者运行 `npm run release:promote`；发布前确认工作树干净，并完成 DSH Web 的真实宿主验收。

DSH 插件规范见 [开发规范](docs/agents/dsh-plugin-development.md)。

## 致谢（Acknowledgments）

* 感谢 [Linux.do](https://linux.do/) 社区对本项目的推广与宝贵反馈。
