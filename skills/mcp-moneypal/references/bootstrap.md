# MCP 与 MoneyPal 启动检查

仅在 `finance_*` 工具不可见或工具明确返回 `runtime_unavailable` 时进入本流程。目标是由 Agent 完成 MCP 连接检查与 MoneyPal 运行时准备；对机器级变更须先向用户展示准确命令并取得明确授权。

## 1. 判断 MCP 状态

1. 当前工具集中存在任一 `finance_*` 工具：MCP 已安装并连接，跳过本节。
2. 工具不存在时检查命令：POSIX 使用 `command -v mcp-moneypal`，PowerShell 使用 `Get-Command mcp-moneypal -ErrorAction SilentlyContinue`。
3. 命令存在但工具不存在：这是 MCP 宿主配置或重启问题。检查宿主配置是否以 `mcp-moneypal` 为命令，并设置了 `MONEYPAL_LEDGER_WORKSPACE`；需要账本工作区时向用户询问，不猜路径。配置完成后请宿主重新加载 MCP，再以 `finance_list_accounts` 成功返回作为完成标准。不要重装已有包。
4. 命令不存在：先运行 `npm --version`。npm 不可用时说明需要 Node.js 22.18+ 与 npm，并停止自动安装；不要擅自安装或替换用户的 Node.js 发行方式。
5. npm 可用时，取得用户对全局安装的授权，然后执行 `npm install -g mcp-moneypal`。安装失败为权限错误时，不使用 `sudo npm`；说明应通过 Node 版本管理器或用户级 npm prefix 修复权限。
6. 安装后重新检查 `mcp-moneypal` 命令，并完成第 3 步的宿主配置与连接验证。命令存在不等于 MCP 已连接。

## 2. 判断 MoneyPal 运行时

1. 工具返回 `runtime_unavailable` 时，确认 MCP 宿主可执行 `mcp-moneypal setup-runtime`，或检查其环境中是否已设置绝对路径的 `MONEYPAL_PYTHON`。
2. 使用托管运行时时，先取得用户对运行时创建与依赖安装的授权，再执行 `mcp-moneypal setup-runtime`；不要覆盖 `MONEYPAL_PYTHON` 指定的外部解释器。
3. 完成后调用 `finance_validate_journal`。成功才算环境就绪。

## 3. 停止条件

- 同一准备命令因相同原因连续失败两次时停止重试，报告命令、错误和仍缺少的依赖。
- 运行时可用但 `finance_*` 工具仍不可见时，回到 MCP 宿主配置与重载，不重复准备运行时。
- `invalid_workspace`、`invalid_ledger_layout`、账户声明错误和账本校验错误都不通过重新准备运行时解决；保持正式账本不变并按各自错误处理。
