# dsh-moneypal

MoneyPal 的 DSH Web 插件。它为当前账本工作区提供六个只读财务工具、一个受确认保护的记账工具、一个受确认保护的账本初始化工具，以及原生账户余额抽屉。

## 安装

前置条件：Node.js 22.18+、可用的 MoneyPal 运行时，以及可用的 DSH Web profile。

```bash
dsh plugin --profile web add dsh-moneypal
dsh plugin --profile web exec dsh-moneypal install-preset
```

随后重启 DSH Web、硬刷新浏览器，并选择新生成的 `dsh-moneypal` 托管预设。

## 卸载

先关闭 DSH Web，再按顺序运行：

```bash
dsh plugin --profile web exec dsh-moneypal uninstall-preset
dsh plugin --profile web remove dsh-moneypal
```

第一条命令只删除本插件生成的托管预设（`<DSH_HOME>/.agent-presets/dsh-moneypal`，默认 `~/.dsh/.agent-presets/dsh-moneypal`）：缺少 `# dsh-moneypal-managed: true` 标记时拒绝删除，重复执行安全。第二条命令移除 Web profile 中的 npm 包；顺序不能颠倒，因为卸载命令来自该插件。共享 MoneyPal 运行时不会被自动删除。

## 初始化账本

```bash
dsh plugin --profile web exec dsh-moneypal init /path/to/ledger-workspace
```

插件只读取当前 DSH 会话挂载的账本工作区，正式写入前必须由根 Agent 展示完整交易并获得人的明确确认。

根 Agent 也可在 DSH Web 中调用 `finance_initialize_ledger` 初始化当前挂载工作区。工具使用服务器本地当前年份，展示固定账户和将创建的文件后请求确认；子 Agent 无权调用，已有 `default/` 时拒绝覆盖。

MCP 宿主请安装独立的 `mcp-moneypal` 包。
