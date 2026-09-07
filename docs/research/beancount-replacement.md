# 用 Beancount 替换 hledger 是否适合解决 Windows MCP UTF-8 问题

调研日期：2026-09-02  
适用仓库：MoneyPal / hledger-agent

## 结论

技术上可行，但如果唯一动机是修复“Windows 无控制台 MCP 子进程无法读取 UTF-8 journal”，不建议替换。

Beancount 3 是 Python 包，在 Windows 上提供预编译 wheel；通过 Python 的 UTF-8 模式或显式 `encoding="utf-8"` 可以建立不依赖 Windows ANSI code page 的进程边界。因此它能避开 hledger/GHC 当前的无控制台编码问题。[Beancount PyPI](https://pypi.org/project/beancount/)；[Python UTF-8 mode](https://docs.python.org/3/using/windows.html#utf-8-mode)

但本仓库不仅把 hledger 当作校验器，还把它的命令、查询语义和 JSON 结构当作内部协议。替换意味着迁移账本语言、查询实现、输出适配、候选交易校验及大量集成测试；成本远高于给 hledger 建立进程级 UTF-8 边界。

## Beancount 能解决什么

- Beancount 3 自 2024 年 6 月起是当前稳定版本；当前 PyPI 发行版提供 Windows x86-64 wheel。[Beancount 仓库](https://github.com/beancount/beancount)；[Beancount PyPI](https://pypi.org/project/beancount/)
- `bean-check` 可以加载整个账本并执行语法、平衡和插件校验。[Beancount 入门文档](https://beancount.github.io/docs/getting_started_with_beancount/)
- Python API 可以直接返回 entries、errors 和 options，适合用一个小型 Python bridge 输出由本项目定义的 UTF-8 JSON，而不是依赖终端文本。
- Python 可用 `-X utf8` 或 `PYTHONUTF8=1` 固定标准流和默认文本编码，不依赖 console 是否存在。[Python 命令行文档](https://docs.python.org/3/using/cmdline.html#cmdoption-X)

这意味着 Beancount 后端可以可靠运行在 GUI/MCP → Node → Python 的无控制台链路中。

## 它不是 hledger 的直接替换品

### 账本语法不同

本仓库目前生成 hledger 交易：

```hledger
2026-09-02 午餐
    Expenses:家庭:食品    30 CNY
    Assets:支付宝
```

Beancount 交易至少需要状态标记和带引号的描述：

```beancount
2026-09-02 * "午餐"
  Expenses:F家庭:F食品  30 CNY
  Assets:A支付宝
```

账户声明也要从 hledger 的 `account` 指令迁移成带日期的 Beancount `open` 指令。Beancount 会检查账户的 open/close 生命周期，这与当前规则不同。[Beancount 语言语法](https://beancount.github.io/docs/beancount_language_syntax/)

### 中文账户名不能原样保留

Beancount 当前账户组件必须以 Unicode 大写字母或数字开头，后续才允许一般 Unicode 字母或数字。源码中的规则是 `ACC_COMP_NAME_RE = [\p{Lu}\p{Nd}][\p{L}\p{Nd}\-]*`。[Beancount account.py](https://github.com/beancount/beancount/blob/master/beancount/core/account.py)

因此本仓库现有的以下名称不能原样使用：

- `Assets:支付宝`
- `Expenses:家庭:食品`
- `Income:工资`

它们需要改名，例如 `Assets:A支付宝`、`Expenses:F家庭:F食品`，或全面改用英文/拼音。这是数据迁移和用户体验变化，不是单纯的编码适配。

### Beancount 3 的查询工具已拆包

Beancount 3 核心包只注册 `bean-check`、`bean-doctor`、`bean-example`、`bean-format` 和 `treeify` 等命令；旧文档里的 `bean-report`、`bean-query` 和 `bean-web` 已从核心移除。[Beancount pyproject.toml](https://github.com/beancount/beancount/blob/master/pyproject.toml)；[旧报告文档的 v3 警告](https://beancount.github.io/docs/running_beancount_and_generating_reports/)

查询需要另装 `beanquery`，或直接使用 Beancount Python API 自行聚合。`beanquery` 是独立发行包。[beanquery PyPI](https://pypi.org/project/beanquery/)

## 对本仓库的具体影响

当前 `HledgerClient` 直接依赖以下 hledger 能力：

- `balance -O json`
- `register -O json`
- `incomestatement -O json`
- `balancesheet -O json`
- `accounts --declared --flat`
- `check`
- `files`
- 同时传入正式主账本和候选 journal 进行校验
- `print -O json`，用于疑似重复交易检查

替换时至少需要：

1. 新建明确的账本引擎接口，并实现 Beancount/Python bridge。
2. 重新定义六个只读工具的稳定 JSON schema，不能继续透传 hledger JSON。
3. 用 BQL 或 Python API实现余额、流水、损益表和资产负债表的日期语义。
4. 从 loader 的 options 中取得完整 include 文件集，重做账本快照。
5. 重写候选交易渲染与校验；Beancount `bean-check` 只接收一个入口文件，需生成临时聚合入口或在 Python 内合并 entries 后执行校验。
6. 迁移 `main.journal`、`accounts.journal`、年度交易文件和全部账户声明。
7. 重写余额抽屉对 hledger JSON 的解析。
8. 重新建立真实引擎集成测试和安装流程。

此外，本项目当前强调 Node 22+、hledger CLI 和零 Node 运行时依赖。Beancount 方案会增加 Python 3.9+、Beancount、可能还有 beanquery 及其版本管理。

## 建议

### 仅解决 Windows MCP UTF-8

保留 hledger。优先级建议是：

1. 使用带 `<activeCodePage>UTF-8</activeCodePage>` 的独立 `hledger-utf8.exe` 副本，并通过 `HLEDGER_AGENT_HLEDGER` 指向它。
2. 或提供一个很小的定制 hledger 构建，在入口处显式设置 locale/stdin/stdout/stderr 为 UTF-8。
3. 或在 Windows 上把执行后端放进 WSL。

这些方案不要求迁移账本格式、账户名和报告语义。

### 何时值得选择 Beancount

只有当需求本身同时包括以下一项或多项时，才值得把 Beancount 作为独立产品决策评估：

- 希望把财务引擎嵌入 Python，并直接操作结构化 entries；
- 需要 Beancount 的 lot/inventory、插件和严格账户生命周期语义；
- 接受迁移全部账本数据和账户命名；
- 接受新增 Python 与 beanquery 依赖；
- 愿意重新定义 MoneyPal 的内部财务结果 schema。

如果选择这条路，应先做一个只读原型：用一份小型 Beancount 测试账本实现 `validate`、账户列表、余额和流水四项，不要直接改写现有正式账本或写入链路。原型通过后再决定是否迁移损益表、资产负债表和确认写入。
