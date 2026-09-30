// 发布测试包装：先严格要求真实运行时可用且兼容，再按顺序运行集成层与发布产物层测试。
// 通过 npm run test:release 调用；本脚本不构建、不打包、不安装环境、不运行浏览器。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("..", import.meta.url));

let runtimeSkipReason;
try {
  ({ runtimeSkipReason } = await import("../dist/test/runtime-fixtures.js"));
} catch (error) {
  console.error(`无法加载运行时检查模块（请先执行 npm run build）：${error?.message ?? error}`);
  process.exit(1);
}

process.env.MONEYPAL_TEST_REQUIRE_RUNTIME = "1";
let reason;
try {
  reason = await runtimeSkipReason();
} catch (error) {
  reason = error instanceof Error && error.message ? error.message : "发布测试需要可用且兼容的 MoneyPal 运行时，请先配置运行时。";
}
if (reason !== false) {
  console.error(reason);
  process.exit(1);
}

const npmExecPath = process.env.npm_execpath;
if (typeof npmExecPath !== "string" || npmExecPath.length === 0) {
  console.error("缺少 npm_execpath；请通过 npm run test:release 调用发布测试。");
  process.exit(1);
}

for (const name of ["test:integration:built", "test:release:built"]) {
  const result = spawnSync(process.execPath, [npmExecPath, "run", name], { cwd: workspace, env: process.env, stdio: "inherit" });
  if (result.error) {
    console.error(`无法启动 ${name}：${result.error.message}`);
    process.exit(1);
  }
  if (result.signal) {
    console.error(`${name} 被信号终止：${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
