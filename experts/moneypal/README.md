# 恰恰账本

“恰恰账本”是使用 MoneyPal MCP 管理本地 Beancount 账本的个人财务管家专家，可导入 WorkBuddy 与 Qoder。它可查询流水、余额、损益表、资产负债表和账户，并将记账固定为“预览 → 人工确认 → 提交”。

## 使用前准备

专家包只声明了 `mcp-moneypal` 命令，不会包含你的账本路径、账本内容或任何密钥。导入专家前，请先安装 MCP 包：

```bash
npm install -g mcp-moneypal
```

然后在宿主（WorkBuddy / Qoder）的用户级或项目级 MCP 配置中，为 `moneypal` 配置正式账本工作区：

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

## 导入 WorkBuddy

完成 MCP 配置并重新加载 WorkBuddy 后，上传本项目生成的 `dist/experts/moneypal.zip`。

## 导入 Qoder

完成 MCP 配置后，使用 Qoder（Desktop / CLI）的插件安装方式导入本项目生成的 `dist/experts/moneypal-{version}.zip`：包内 `.qoder-plugin/plugin.json` 为插件清单，`skills/`、`agents/` 与 `.mcp.json` 分别提供 MoneyPal 领域技能、管家定义和 MCP 服务器声明，连接依赖详见包内 `CONNECTORS.md`。

导入后在工具不可用或运行时缺失时，专家会说明下一步；它不会猜测或写入你的账本目录。

## 构建专家包

在本仓库根目录执行：

```bash
npm run build
```

生成两个可分发文件：

- `dist/experts/moneypal.zip` — WorkBuddy 专家包，解压后顶层目录为 `moneypal/`，其中包括专家定义、MCP 声明、头像与 MoneyPal 领域技能。
- `dist/experts/moneypal-{version}.zip` — Qoder 插件包，zip 根目录即插件根，其中包括 `.qoder-plugin/plugin.json` 清单、MoneyPal 领域技能、agent 定义、MCP 声明与 `CONNECTORS.md`。
