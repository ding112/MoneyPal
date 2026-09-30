# dsh-moneypal

MoneyPal 的 DSH Web 插件。它为当前账本工作区提供六个只读财务工具、一个受确认保护的记账工具、一个受确认保护的账本初始化工具，以及原生资产负债概览抽屉。

## 安装

前置条件：Node.js 22.18+、DSH 0.1.7-rc.2 或更新版本的 Web profile，以及可用的 MoneyPal 运行时。

```bash
dsh plugin --profile web add dsh-moneypal
```

预设随插件 bundle 自动注册。重启 DSH Web 后，在新会话中选择 MoneyPal。

在 `dsh-market` 中点击 MoneyPal 卡片安装的是 npm 已发布包 `dsh-moneypal`，版本跟随 registry 的 `latest` 标签。本目录（`packages/dsh-moneypal/`）供市场目录发现包名与 `cordis.patch.yml`，不是已构建的安装目录；从本地源码安装请先 `npm run build`，再安装 `dist/packages/dsh-moneypal`。

## 卸载

先关闭 DSH Web，再按顺序运行：

```bash
dsh plugin --profile web remove dsh-moneypal
```

重启 DSH Web 后，预设从新会话列表中移除。旧版遗留的 `.agent-presets/dsh-moneypal` 目录会被新版 DSH 忽略，本插件不会自动删除。共享 MoneyPal 运行时不会随 bundle 移除。

## 初始化账本

```bash
dsh plugin --profile web exec dsh-moneypal init /path/to/ledger-workspace
```

插件只读取当前 DSH 会话挂载的账本工作区，正式写入前必须由根 Agent 展示完整交易并获得人的明确确认。

根 Agent 也可在 DSH Web 中调用 `finance_initialize_ledger` 初始化当前挂载工作区。工具使用服务器本地当前年份，展示固定账户和将创建的文件后请求确认；子 Agent 无权调用，已有 `default/` 时拒绝覆盖。
