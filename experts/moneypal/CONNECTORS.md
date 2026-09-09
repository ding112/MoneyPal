# Connector 依赖

## MoneyPal MCP（mcp-moneypal）

- **用途**：专家的全部能力——查流水、余额、损益表、资产负债表、账户、整本校验，以及预览并提交记账——都依赖此 MCP 服务器
- **资源**：本机 Beancount 账本工作区（由 `MONEYPAL_LEDGER_WORKSPACE` 指定，应包含 `default/main.beancount`、`default/accounts.beancount` 和 `default/transactions/`）
- **类型**：本地进程模式（stdio），账本数据不经网络传输
- **配置方式**：
  1. 安装 MCP 包：`npm install -g mcp-moneypal`
  2. 在 WorkBuddy / Qoder 的用户级或项目级 MCP 配置中声明服务器，并为 `moneypal` 提供正式账本工作区：

     ```json
     {
       "mcpServers": {
         "moneypal": {
           "command": "mcp-moneypal",
           "env": {
             "MONEYPAL_LEDGER_WORKSPACE": "/absolute/path/to/ledger-workspace"
           }
         }
       }
     }
     ```

  3. 首次使用托管运行时前，取得机器级变更授权后执行 `mcp-moneypal setup-runtime`；也可以通过 `MONEYPAL_PYTHON` 指定现有解释器
- **权限边界**：只读写上述工作区内的账本文件；所有写入固定为「预览 → 人工确认 → 提交」，失败即保持账本不变。插件包不携带任何本机路径、密钥或账本内容。
