# mcp-moneypal

MoneyPal 的 MCP stdio 服务器。它向 WorkBuddy 等 MCP 宿主提供六个只读 Beancount 财务工具，以及由“预览 → 人确认 → 提交”保护的记账工具。

随包提供的 `mcp-moneypal` 技能会在 MCP 工具缺失或 MoneyPal 运行时不可用时检查环境，并在取得授权后完成运行时准备与复验。

## 安装

前置条件：Node.js 22.18+ 和可用的 MoneyPal 运行时。

```bash
npm install -g mcp-moneypal
```

在 MCP 宿主中将命令配置为 `mcp-moneypal`，并提供账本工作区：

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

初始化新账本工作区：

```bash
mcp-moneypal init /path/to/ledger-workspace
```

DSH Web 请安装独立的 `dsh-moneypal` 包。
