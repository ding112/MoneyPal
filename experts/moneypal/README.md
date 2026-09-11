# 恰恰账本

“恰恰账本”是使用 MoneyPal MCP 管理本地 Beancount 账本的个人财务管家专家，可导入 WorkBuddy 与 Qoder。它可查询流水、余额、损益表、资产负债表和账户，并将记账固定为“预览 → 人工确认 → 提交”。

## 使用前准备

专家包只声明了 `mcp-moneypal` 命令，不包含个人账本路径、账本内容或密钥。安装程序与配置连接器都完成后，专家从当前 Agent 任务取得账本工作区，再随工具调用传入。

可让助手“带我一步步连接账本”：按 [启动检查](skills/mcp-moneypal/references/bootstrap.md) 准备程序、运行时和账本，再按 [连接器配置指引](skills/mcp-moneypal/references/connectors.md) 在应用界面中配置。新连接器不设置账本环境变量；已有 `MONEYPAL_LEDGER_WORKSPACE` 的旧配置继续兼容。

## 导入 WorkBuddy

完成 MCP 配置并重新加载 WorkBuddy 后，上传本项目生成的 `dist/experts/moneypal.zip`。

## 导入 Qoder

完成 MCP 配置后，使用 Qoder（Desktop / CLI）的插件安装方式导入本项目生成的 `dist/experts/moneypal-{version}.zip`：包内 `.qoder-plugin/plugin.json` 为插件清单，`skills/`、`agents/` 与 `.mcp.json` 分别提供 MoneyPal 领域技能、管家定义和 MCP 服务器声明，连接依赖详见包内 `CONNECTORS.md`。

导入后，专家会复用已有 MoneyPal 连接器并核验；缺少配置时逐步指导补齐。它不会猜测账本目录，也不会重复初始化已有账本。

## 构建专家包

在本仓库根目录执行：

```bash
npm run build
```

生成两个可分发文件：

- `dist/experts/moneypal.zip` — WorkBuddy 专家包，解压后顶层目录为 `moneypal/`，其中包括专家定义、MCP 声明、头像与 MoneyPal 领域技能。
- `dist/experts/moneypal-{version}.zip` — Qoder 插件包，zip 根目录即插件根，其中包括 `.qoder-plugin/plugin.json` 清单、MoneyPal 领域技能、agent 定义、MCP 声明与 `CONNECTORS.md`。
