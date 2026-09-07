# Agent instructions

## Agent skills

### Issue tracker

Issue 和 spec 使用本仓库 `.scratch/` 下的 Markdown 文件管理。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认的五个 triage 标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。详见 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context 布局：根目录 `CONTEXT.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。

### DSH 插件开发规范

修改 DSH/MCP 插件入口、服务注入、工具契约、宿主注册、运行时依赖或发布流程前，必须先读取 `docs/agents/dsh-plugin-development.md`。

### 端到端测试

端到端测试统一使用 `ego-browser` skill，不得自行改用其他浏览器自动化方案。执行前先读取该 skill：`~/.agents/skills/ego-browser/SKILL.md`。
