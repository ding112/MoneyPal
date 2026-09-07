import assert from "node:assert/strict";
import { test } from "node:test";

import { BatchRegistry } from "../src/mcp/batches.js";
import type { ConfirmedTransactionWriter } from "../src/finance/write.js";

const writer: ConfirmedTransactionWriter = {
  preview: async () => { throw new Error("测试不应调用 preview"); },
  commit: async () => { throw new Error("测试不应调用 commit"); },
};

test("批次注册表将过期、替换、提交和并发提交保持为不同的有界状态", () => {
  const registry = new BatchRegistry(10, 2);
  const first = registry.register(writer, 0);
  const second = registry.register(writer, 0);
  registry.register(writer, 0);
  assert.deepEqual(registry.consume(first.id, 1), { available: false, reason: "replaced" });

  assert.equal(registry.consume(second.id, 1).available, true);
  assert.deepEqual(registry.consume(second.id, 1), { available: false, reason: "committing" });
  registry.complete(second.id, "submitted");
  assert.deepEqual(registry.consume(second.id, 1), { available: false, reason: "submitted" });

  const failed = registry.register(writer, 1);
  assert.equal(registry.consume(failed.id, 1).available, true);
  registry.complete(failed.id, "commit_failed");
  assert.deepEqual(registry.consume(failed.id, 1), { available: false, reason: "commit_failed" });

  const expiring = registry.register(writer, 10);
  assert.deepEqual(registry.consume(expiring.id, 20), { available: false, reason: "expired" });
});
