import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INITIALIZE_LEDGER_OUTPUT_SCHEMA,
  LEDGER_ENGINE_OPERATIONS,
  readRegisterQuery,
  READ_ONLY_TOOL_DEFINITIONS,
} from "../src/finance/contract.js";
import type { LedgerEngine, RegisterResult } from "../src/finance/types.js";
import { omitSchemaDescriptions } from "./contract-fixtures.js";

test("完整流水查询使用共享 LedgerEngine 契约，并传递文本和数量限制", async () => {
  const expected: RegisterResult = {
    range: { begin: "2026-01-01", end: "2026-02-01" },
    truncated: true,
    transactions: [{
      date: "2026-01-02",
      flag: "*",
      payee: "商店",
      narration: "午餐",
      tags: ["food"],
      links: ["receipt-1"],
      metadata: { receipt: "A-1" },
      postings: [{
        account: "Assets:C-现金",
        units: { commodity: "CNY", quantity: "-12.5" },
        cost: { currency: "CNY", number: "10", date: "2026-01-01", label: null },
        price: { commodity: "USD", quantity: "2" },
        flag: null,
        metadata: { note: "含税" },
      }],
    }],
  };
  const engine = { queryRegister: async () => expected } as unknown as LedgerEngine;

  assert.deepEqual(
    await LEDGER_ENGINE_OPERATIONS.finance_query_register!(engine, readRegisterQuery({
      account: "Assets",
      begin: "2026-01-01",
      end: "2026-02-01",
      text: "午餐",
      limit: 1,
    }), new AbortController().signal),
    expected,
  );

  const definition = READ_ONLY_TOOL_DEFINITIONS.find(({ name }) => name === "finance_query_register");
  assert.deepEqual(omitSchemaDescriptions(definition?.parameters), omitSchemaDescriptions({
    type: "object",
    properties: {
      account: { type: "string", description: "可选的账户名称。" },
      begin: { type: "string", description: "起始日期，必须是绝对日期 YYYY-MM-DD。" },
      end: { type: "string", description: "结束日期，必须是绝对日期 YYYY-MM-DD，作为排他边界处理。" },
      text: { type: "string", description: "可选的大小写敏感文本；匹配交易的 payee 或 narration。" },
      limit: { type: "integer", minimum: 1, description: "可选的最大返回交易数；结果另以 truncated 标识是否仍有匹配交易。" },
    },
    additionalProperties: false,
  }));
});

test("流水查询拒绝非正整数限制", () => {
  assert.throws(() => readRegisterQuery({ limit: 0 }), /limit 必须是正整数/u);
  assert.throws(() => readRegisterQuery({ limit: 1.5 }), /limit 必须是正整数/u);
});

test("初始化输出契约符合 DSH 支持的 JSON Schema 子集", () => {
  const initialized = INITIALIZE_LEDGER_OUTPUT_SCHEMA.oneOf[0];
  assert.deepEqual(omitSchemaDescriptions(initialized.properties.initialized), omitSchemaDescriptions({ type: "boolean", const: true }));
  assert.deepEqual(omitSchemaDescriptions(initialized.properties.ledgerDirectory), omitSchemaDescriptions({ type: "string", const: "default" }));
  assert.deepEqual(omitSchemaDescriptions(initialized.properties.year), omitSchemaDescriptions({ type: "integer" }));
  assert.equal("minimum" in initialized.properties.year, false);
  assert.equal("maximum" in initialized.properties.year, false);
});
