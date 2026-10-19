# MoneyPal 开发与发布

[返回产品首页](README.md)

本仓库只构建和发布 `dsh-moneypal`。从源码安装：

```bash
npm ci
npm run build
dsh plugin --profile web add /path/to/MoneyPal/dist/packages/dsh-moneypal
```

`packages/dsh-moneypal/` 是市场发现用清单及补丁源，不是可直接安装的构建目录。

验证命令：

```bash
npm run typecheck
npm run test:fast
npm test
npm run test:release
```

涉及发布的改动使用 `npm run test:release`。该门禁要求真实兼容的 MoneyPal 运行时，并检查实际 tarball、隔离安装和包入口。

根工作区标记为 `private`，不可直接发布。Release 工作流验证版本与 tag，构建并验收单个 DSH tarball，再通过 npm OIDC Trusted Publishing 发布到 `next`。稳定版的 `latest` 提升由维护者运行 `npm run release:promote`；发布前确认工作树干净，并完成 DSH Web 的真实宿主验收。

DSH 插件规范见 [开发规范](docs/agents/dsh-plugin-development.md)。
