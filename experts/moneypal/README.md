# 恰恰账本

“恰恰账本”是使用 MoneyPal MCP 管理本地 Beancount 账本的 WorkBuddy 专家。它可查询流水、余额、损益表、资产负债表和账户，并将记账固定为“预览 → 人工确认 → 提交”。

## 使用前准备

专家 ZIP 只声明了 `mcp-moneypal` 命令，不会包含你的账本路径、账本内容或任何密钥。导入专家前，请先安装 MCP 包：

```bash
npm install -g mcp-moneypal
```

然后在 WorkBuddy 的用户级或项目级 MCP 配置中，为 `moneypal` 配置正式账本工作区：

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

工作区应包含 `default/main.beancount`、`default/accounts.beancount` 和 `default/transactions/`。首次使用托管运行时前，取得机器级变更授权后执行 `mcp-moneypal setup-runtime`；也可以通过 `MONEYPAL_PYTHON` 配置现有解释器。

完成 MCP 配置并重新加载 WorkBuddy 后，上传本项目生成的 `moneypal.zip`。专家在工具不可用或运行时缺失时会说明下一步；它不会猜测或写入你的账本目录。

## 构建专家包

在本仓库根目录执行：

```bash
npm run build
```

生成的可上传文件为 `dist/experts/moneypal.zip`。解压后顶层目录为 `moneypal/`，其中包括专家定义、MCP 声明、头像与 MoneyPal 领域技能。
