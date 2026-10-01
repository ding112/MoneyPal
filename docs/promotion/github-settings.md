# MoneyPal GitHub 展示设置清单

状态：待应用。本次仅准备本地文档；以下设置尚未修改到 GitHub。

MoneyPal 是统一产品品牌，[主仓库](https://github.com/ding112/MoneyPal)承担产品主页，[Skill 仓库](https://github.com/ding112/moneypal-skill)承担通用技能分发入口。

## MoneyPal 主仓库

Description：

> 让你的 AI 助手真正会记账。支持支付宝、微信及各大银行账单自动导入，预览确认后入账；本地优先，基于 Beancount。

Topics（保留已有主题，补齐以下主题）：

```text
beancount
personal-finance
accounting
ai-agent
mcp
model-context-protocol
local-first
agent-skills
deepseek-harness
dsh-plugin
```

Homepage：保持现状，不新增独立网站链接。

## MoneyPal Skill 分发仓库

Description：

> MoneyPal 通用 Agent Skill：支持支付宝、微信及各大银行账单自动导入、自然语言查账与确认后记账，适用于 WorkBuddy、Qoder 等应用。

Topics（保留已有主题，补齐以下主题）：

```text
beancount
personal-finance
accounting
ai-agent
mcp
model-context-protocol
local-first
agent-skills
```

Homepage：[MoneyPal 产品主页](https://github.com/ding112/MoneyPal#readme)。

## 应用与复核

后续发布 README 改动后，在两个 GitHub 仓库的 About 设置中分别填写上述 Description、Topics 和 Homepage，再核对保存结果。此清单不代表 README 已推送或设置已生效。

- 检查两仓库首页的安装入口和互链，确认能到达对应章节。
- 保留主仓库已有的 `dsh-plugin` 主题；Skill 仓库不添加该主题，因为它交付通用技能目录。
- 账单自动导入指用户提供导出的账单文件，由 AI 整理、展示预览，用户确认后写入。
- 当前演示是标注虚构数据的文字示例；真实产品 GIF 留待后续制作。
