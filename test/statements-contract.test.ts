import assert from "node:assert/strict";
import { test } from "node:test";

import { errorResponse, LEDGER_ENGINE_OPERATIONS, readStatementRange, READ_ONLY_TOOL_DEFINITIONS } from "../src/finance/contract.js";
import type { LedgerEngine } from "../src/finance/types.js";
import { omitSchemaDescriptions } from "./contract-fixtures.js";

test("两个报表工具经共享 LedgerEngine 契约传递严格校验的日期区间", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const engine = {
    getIncomeStatement: async (range: unknown) => { calls.push({ name: "income", args: range as Record<string, unknown> }); return { range }; },
    getBalanceSheet: async (range: unknown) => { calls.push({ name: "sheet", args: range as Record<string, unknown> }); return { range }; },
  } as unknown as LedgerEngine;

  const signal = new AbortController().signal;
  assert.deepEqual(
    await LEDGER_ENGINE_OPERATIONS.finance_get_income_statement!(engine, { begin: "2026-01-01", end: "2026-02-01" }, signal),
    { range: { begin: "2026-01-01", end: "2026-02-01" } },
  );
  assert.deepEqual(
    await LEDGER_ENGINE_OPERATIONS.finance_get_balance_sheet!(engine, { end: "2026-02-01" }, signal),
    { range: { end: "2026-02-01" } },
  );
  assert.deepEqual(calls, [
    { name: "income", args: { begin: "2026-01-01", end: "2026-02-01" } },
    { name: "sheet", args: { end: "2026-02-01" } },
  ]);
});

test("报表日期区间拒绝格式错误、无效日历日期与 begin 不早于 end", () => {
  assert.throws(() => readStatementRange({ begin: "2026-2-1" }), /日期参数必须使用绝对日期 YYYY-MM-DD/u);
  assert.throws(() => readStatementRange({ begin: 20260101 }), /日期参数必须使用绝对日期 YYYY-MM-DD/u);
  assert.throws(() => readStatementRange({ end: "2026-02-30" }), /无效日期/u);
  assert.throws(() => readStatementRange({ begin: "2026-02-01", end: "2026-02-01" }), /begin 必须早于 end/u);
  assert.throws(() => readStatementRange({ begin: "2026-05-01", end: "2026-04-01" }), /begin 必须早于 end/u);
  assert.deepEqual(readStatementRange({}), {});
  assert.deepEqual(readStatementRange({ begin: "2026-01-01" }), { begin: "2026-01-01" });
});

test("报表参数错误经公共错误体系映射为 invalid_request，工具名称与参数保持不变", () => {
  const income = READ_ONLY_TOOL_DEFINITIONS.find(({ name }) => name === "finance_get_income_statement");
  const sheet = READ_ONLY_TOOL_DEFINITIONS.find(({ name }) => name === "finance_get_balance_sheet");
  assert.ok(income && sheet);

  assert.deepEqual(omitSchemaDescriptions(income.parameters), omitSchemaDescriptions(sheet.parameters));
  assert.deepEqual(omitSchemaDescriptions(income.parameters), omitSchemaDescriptions({
    type: "object",
    properties: {
      begin: { type: "string", description: "起始日期，必须是绝对日期 YYYY-MM-DD。" },
      end: { type: "string", description: "结束日期，必须是绝对日期 YYYY-MM-DD，作为排他边界处理。" },
    },
    additionalProperties: false,
  }));

  assert.deepEqual(errorResponse(new TypeError("日期参数必须使用绝对日期 YYYY-MM-DD：begin")), { code: "invalid_request", message: "日期参数必须使用绝对日期 YYYY-MM-DD：begin" });
  assert.deepEqual(errorResponse(new RangeError("begin 必须早于 end（end 为排他边界）。")), { code: "invalid_request", message: "begin 必须早于 end（end 为排他边界）。" });
});
