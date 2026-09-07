---
name: mcp-moneypal
description: 通过 MoneyPal MCP 财务工具查询和记账用户的正式账本。当用户要查流水、余额、损益表、资产负债表、可用账户，校验账本，要求记账，或首次使用时需要检查并准备 mcp-moneypal 与 MoneyPal 运行时时使用；包含绝对日期换算和先预览、经用户确认、再提交的写入协议。
---

# MoneyPal MCP 财务工具

你通过 MCP 财务工具访问用户本机的正式账本（账本工作区由 MCP 宿主配置，不在对话中传路径）。工具分两类：

- 六个只读工具：查流水（finance_query_register）、余额（finance_get_balance）、损益表、资产负债表、声明账户列表（finance_list_accounts）、整本校验（finance_validate_journal）。
- 两个写入工具：finance_preview_transactions 生成预览批次，finance_commit_transactions 提交批次。

每个成功响应都带 `serverToday`（服务器本机时区当日，YYYY-MM-DD）。

## 环境就绪门

- 当前工具集中已有 `finance_*` 工具时，MCP 已连接；直接使用工具，不重复检查或安装 `mcp-moneypal`。
- `finance_*` 工具不可见，或工具返回 `runtime_unavailable` 时，读取并执行 [MCP 与 MoneyPal 启动检查](references/bootstrap.md) 中对应的分支。一次对话内已验证就绪后不重复检查。
- `invalid_workspace` 和 `invalid_ledger_layout` 表示 MCP 已运行但配置或账本布局有误，不属于缺少安装；按错误消息修复，不重装软件。

## 财务日期规则

- 所有日期参数必须是绝对日期 YYYY-MM-DD，工具不接受“今天”等相对表述。
- 用户说“今天”“昨天”或只给月、日时，以最近一次 `serverToday` 为准换算年份和日期；用户明确给了年份时不得替换。
- 尚未获得任何 `serverToday` 时，先做一次任意只读查询取回它，或直接向用户确认今天日期；不得臆造日期。
- 对换算结果没有把握（跨时区、深夜、用户质疑日期）时，向用户澄清后再调用；补全后日期无效的，向用户说明，不得擅自改成其他日期。
- `begin`/`end` 采用 begin 含、end 不含的区间：begin=2026-01-01、end=2026-02-01 包含一月，不含二月一日。

## 账户名

- 账户名是大小写精确的完整标识。调用工具、展示预览和回复用户时，原样保留 `finance_list_accounts` 返回的账户名。
- 中文开头的每个非根账户段都必须以字面 `C-` 开头，例如 `Assets:C-支付宝`、`Expenses:C-家庭:C-食品`。`C-` 是 Beancount 账户名的一部分；创建或建议账户声明时添加并保留它，不得在查询参数、候选交易或展示中删除、隐藏或重复添加。
- 英文账户段使用 Beancount 原生形式，例如 `Assets:Cash`；不要给英文段添加 `C-`。

## 查询

- 拿到结果先核对 `serverToday` 与你的日期假设；不符时向用户说明再决定是否重查。
- 用户报出的账户名与流水对不上时，用 finance_list_accounts 核对声明账户的准确拼写。

## 写入协议（人在写入前有最终决定权）

1. 用户提出记账：把交易整理成候选交易，调用 finance_preview_transactions。
2. 拿到预览后，把以下内容完整展示给用户，不得省略或只做摘要：按币种的收支汇总（内部转账不计入）、每笔交易明细、重复警告、目标年度交易文件及是否新建、批次过期时间。
3. 有“可能重复”警告时明确指出，请用户决定保留或丢弃。
4. 仅在用户明确同意后（如回复“确认记账”），调用 finance_commit_transactions 并传入 `batchId`。
5. 用户要求修改或犹豫时，不调用 commit；修改后重新 preview 生成新批次。
6. commit 成功后查询一次流水复核，并向用户确认写入位置。

批次规则：批次 30 分钟过期、待写入至多 3 个、只能消费一次。用户连续报多笔账时，合并成一个预览批次再请确认，减少确认次数；不同年度的日期混在一起时拆开提交。

## 错误恢复

- `batch_unavailable`：批次不存在、已消费或已过期；重新生成预览并再次请用户确认。
- `preview_stale`：预览后账本被改动（可能来自 DSH Web 或另一台机器）；先重新查询，再生成新预览并重新确认。
- `undeclared_account`：账户未在 accounts.beancount 中声明；请用户先做账本维护或改用已声明账户，不要尝试其他写法绕过。
- `ledger_locked`：另一笔写入进行中；稍后重试，不要并行重试。
- `runtime_unavailable`：执行环境就绪门的 MoneyPal 运行时准备分支，完成后再重试原操作。
- `invalid_workspace` / `invalid_ledger_layout`：按错误消息检查 MCP 宿主配置或账本布局，不重装软件。

## 边界

- 只能通过财务工具读账、写账。账户声明、账本布局、锁文件处理属于账本维护，需用户用标准文件工具完成；不要代改账本文件。
- 汇率换算、成本基准、跨商品净值不在工具能力内，如实说明，不要自行折算。
