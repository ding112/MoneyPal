# 通过 MCP stdio 向 WorkBuddy 暴露财务工具

WorkBuddy 用户离开 DSH Web 就失去全部财务工具。经决策，工具层走 MCP 路线：新增零运行时依赖的 MCP stdio 服务器（`dsh-moneypal mcp`），把六个只读工具以与 DSH 完全一致的契约暴露出去，写入则拆为 preview/commit 两步。账本工作区改由 MCP 宿主通过环境变量指定；余额抽屉保持 DSH Web 专属。遵守 ADR-0001（工作区即账本）、ADR-0002（标准工具仍是账本维护通道）、ADR-0003（抽屉为 DSH 原生）。

MCP 的同包交付方式后来由 ADR-0005 取代；工具契约与写入确认决定保持不变。

## Considered Options

- 封装成 WorkBuddy 技能（SKILL.md）：无需协议层，但工具调用退化为 shell 拼接，参数结构化和校验都弱于 MCP，且技能说明容易与工具契约漂移。
- 保持 DSH Web 独占：零新增面积，但日常助手查不了正式账本，用户被迫迁移账本或放弃既有工作流。
- HTTP/SSE 远程传输：可远程访问，但把财务数据引入网络边界，违背本机 hledger、数据不出本机的隐私底线。

## Consequences

- 六个只读工具的名称、描述与参数 schema 在 DSH 与 MCP 间同源共享（`src/finance/contract.ts`）。MCP 没有 DSH 的 time-context 系统提示，因此共享描述要求日期参数使用绝对日期；DSH 的工具描述因此同样带上该要求——这是有意为之，DSH 系统提示本就要求调用前换算为 YYYY-MM-DD，运行时行为不变。
- 写入确认从 DSH 的 userQuestions 对话框变为"预览展示 → 用户在对话中确认 → 提交"两步协议；预览批次 30 分钟过期、待写入至多 3 个、commit 一次性消费，preview_stale 快照校验与账本锁保持不变。
- DSH 的子 Agent 禁写（parentSession 检查）在 MCP 下无等价机制且不予恢复，记为已知限制；由批次过期、快照校验与预览可见性兜底。
- 账本工作区由宿主 env 指定（`MONEYPAL_LEDGER_WORKSPACE`），调用方不得传路径；多账本以多个服务器条目表达。
- MCP 下没有持续可见的余额界面，余额以工具 JSON 输出呈现；抽屉与全局 RPC 适配器保持 DSH Web 专属，不做降级迁移。
- 测试只经子进程加真实 stdio 的协议边界，与宿主使用同一入口；不为测试新增进程内接缝。
- WorkBuddy 强制审批名单对 MCP 工具调用的覆盖尚未证实；若实测可配置，建议把 commit 工具加入强制审批。
- MCP 打通后补了一份技能（`skills/mcp-moneypal/SKILL.md`）：提供日期换算、写入对话、错误恢复、维护边界和环境启动检查，不携带财务工具实现；技能缺失时工具契约自足，仍可使用。
