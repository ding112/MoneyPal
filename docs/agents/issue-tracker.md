# Issue tracker：本地 Markdown

本仓库的 issue 和 spec 使用 `.scratch/` 下的 Markdown 文件管理。

## 约定

- 每个 feature 使用一个目录：`.scratch/<feature-slug>/`
- spec 文件为 `.scratch/<feature-slug>/spec.md`
- implementation issue 每个 ticket 一个文件，路径为 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号，不使用合并的 tickets 文件
- 每个 issue 文件顶部附近使用 `Status:` 行记录 triage 状态，角色字符串见 `triage-labels.md`
- 评论和对话历史追加到文件底部的 `## Comments` 标题下

## 发布到 issue tracker

创建 `.scratch/<feature-slug>/` 目录，并在其中新建对应文件。

## 获取相关 ticket

读取用户指定路径或 issue 编号对应的文件。

## Wayfinding

- Map：`.scratch/<effort>/map.md`，正文包含 Notes、Decisions-so-far 和 Fog
- Child ticket：`.scratch/<effort>/issues/NN-<slug>.md`，使用 `Type:` 记录 `research`、`prototype`、`grilling` 或 `task`，使用 `Status:` 记录 `claimed` 或 `resolved`
- Blocking：使用 `Blocked by: NN, NN` 记录依赖；列出的文件全部为 `resolved` 时 ticket 才算 unblocked
- Frontier：扫描 `issues/`，优先选择编号最小的 open、unblocked、unclaimed ticket
- Claim：设置 `Status: claimed` 后保存
- Resolve：在 `## Answer` 下追加答案，设置 `Status: resolved`，然后将 context pointer 追加到 map 的 Decisions-so-far
