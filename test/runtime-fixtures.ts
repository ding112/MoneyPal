import { inspectRuntime } from "../src/finance/runtime.js";

/**
 * 真实运行时共享检查：available 且 compatible 时返回 false（不跳过）。
 * inspectRuntime 抛错或条件不满足视为不可用，原始异常不进入报告；
 * MONEYPAL_TEST_REQUIRE_RUNTIME=1（仅测试使用）时改为抛出固定错误，供发布包装脚本严格要求。
 */
export async function runtimeSkipReason(): Promise<false | string> {
  let available = false; let compatible = false;
  try {
    const runtime = await inspectRuntime();
    available = runtime.available; compatible = runtime.compatible;
  } catch {
    available = false;
  }
  if (available && compatible) return false;
  if (process.env.MONEYPAL_TEST_REQUIRE_RUNTIME === "1") {
    throw new Error("发布测试需要可用且兼容的 MoneyPal 运行时，请先配置运行时。");
  }
  return "未检测到可用且兼容的 MoneyPal 运行时；请先执行 setup-runtime。";
}
