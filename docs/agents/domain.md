# Domain docs

工程技能探索代码库时，应按以下规则读取领域文档。

## 开始探索前读取

- 根目录的 `CONTEXT.md`；或
- 如果存在根目录 `CONTEXT-MAP.md`，读取它指向的、与当前主题相关的各个 `CONTEXT.md`
- 读取与当前工作区域相关的 `docs/adr/`

如果这些文件不存在，静默继续，不要主动要求预先创建。`domain-modeling` 技能会在领域术语或决策真正确定时按需创建它们。

## 单上下文目录结构

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

## 使用术语表

issue 标题、重构建议、假设和测试名称中的领域概念，应使用 `CONTEXT.md` 定义的术语。若术语表明确避免某个同义词，不要改用该同义词。

如果所需概念尚未出现在术语表中，记录为 `domain-modeling` 的待解决缺口。

## 标记 ADR 冲突

如果输出与现有 ADR 冲突，应显式指出，而不是静默覆盖。例如：

> 与 ADR-0007 冲突，但由于……值得重新开启。
