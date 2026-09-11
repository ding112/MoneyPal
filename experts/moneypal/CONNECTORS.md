# 连接器依赖

## MoneyPal MCP（mcp-moneypal）

本专家的查询、校验、交易预览与提交依赖本地 stdio 服务 `mcp-moneypal`。账本工作区取自当前 Agent 任务，并随每次需要账本的工具调用传入；专家包不携带个人路径、密钥或账本内容。

首次使用可直接请专家“带我一步步连接账本”：助手按 [启动检查](skills/mcp-moneypal/references/bootstrap.md) 在授权范围内准备程序、运行时和账本，再按 [办公 Agent 连接器配置](skills/mcp-moneypal/references/connectors.md) 指导你在 WorkBuddy、Qoder 或 QoderWork 的界面中填写、保存和启用连接器。

已导入的 MoneyPal 条目优先复用；新连接器只需配置启动命令，不设置 `MONEYPAL_LEDGER_WORKSPACE`。已有该环境变量的旧配置继续兼容。安装程序或导入专家不等于已连接个人账本，最终以当前任务目录下的账户查询和账本校验成功验收。交易仍须经过预览、用户确认与提交。
