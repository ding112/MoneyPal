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
  const workspace = { key: "/ledger/a", source: "argument" as const };
  const first = registry.register(writer, workspace, 0);
  const second = registry.register(writer, workspace, 0);
  registry.register(writer, workspace, 0);
  assert.deepEqual(registry.consume(first.id, 1), { available: false, reason: "replaced" });

  assert.equal(registry.consume(second.id, 1).available, true);
  assert.deepEqual(registry.consume(second.id, 1), { available: false, reason: "committing" });
  registry.complete(second.id, "submitted");
  assert.deepEqual(registry.consume(second.id, 1), { available: false, reason: "submitted" });

  const failed = registry.register(writer, workspace, 1);
  assert.equal(registry.consume(failed.id, 1).available, true);
  registry.complete(failed.id, "commit_failed");
  assert.deepEqual(registry.consume(failed.id, 1), { available: false, reason: "commit_failed" });

  const expiring = registry.register(writer, workspace, 10);
  assert.deepEqual(registry.consume(expiring.id, 20), { available: false, reason: "expired" });
});

test("不同账本各自保留待提交批次容量", () => {
  const registry = new BatchRegistry(10, 1);
  const firstLedger = registry.register(writer, { key: "/ledger/a", source: "argument" }, 0);
  const secondLedger = registry.register(writer, { key: "/ledger/b", source: "legacy_env" }, 0);

  assert.deepEqual(registry.consume(firstLedger.id, 1), {
    available: true,
    writer,
    workspaceSource: "argument",
  });
  assert.deepEqual(registry.consume(secondLedger.id, 1), {
    available: true,
    writer,
    workspaceSource: "legacy_env",
  });
});
