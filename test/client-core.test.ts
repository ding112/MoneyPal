import assert from "node:assert/strict";
import { test } from "node:test";

import { dayAfter, snapshotFromBalance } from "../src/balance.js";
import { formatAmount, formatAmountParts } from "../src/client.js";

// 本文件覆盖 src/client.ts 与 src/balance.ts 的领域纯函数（金额、日期、快照 DTO）。
// 控制器与页面视图模型行为见 page-core.test.ts；旧抽屉控制器已随独立账户页交付移除。

test("日期与金额格式使用精确整数，而非浮点数", () => {
  assert.equal(dayAfter("2026-12-31"), "2027-01-01");
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12345678901234567.89" }), "12,345,678,901,234,567.89 CNY");
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12.34" }, true), "-12.34 CNY");
  // 超出安全整数范围与超过 20 位小数：逐字保留，不丢位、不舍入
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12345678901234567890123456789.00" }), "12,345,678,901,234,567,890,123,456,789.00 CNY");
  assert.equal(formatAmount({ commodity: "CNY", quantity: "0.123456789012345678901234567890" }), "0.123456789012345678901234567890 CNY");
  // 中英文 locale 均保留精度与分组；缺省参数回退中文
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12345678901234567.89" }, false, "en-US"), "12,345,678,901,234,567.89 CNY");
  assert.equal(formatAmount({ commodity: "CNY", quantity: "12345678901234567.89" }, false, "zh-CN"), "12,345,678,901,234,567.89 CNY");
});

test("金额拆分为数值、币种与负值标记，供界面分别排版", () => {
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "12345678901234567.89" }), { value: "12,345,678,901,234,567.89", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "-12.34" }), { value: "-12.34", currency: "CNY", negative: true });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "-12.34" }, true), { value: "12.34", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "USD", quantity: "120.00" }, true), { value: "-120.00", currency: "USD", negative: true });
  // 尾随零逐字保留；负资产与负债取反语义不变
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "0.30" }), { value: "0.30", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "100.00" }), { value: "100.00", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "-500.00" }), { value: "-500.00", currency: "CNY", negative: true });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "-1200.00" }, true), { value: "1,200.00", currency: "CNY", negative: false });
  assert.deepEqual(formatAmountParts({ commodity: "CNY", quantity: "50.00" }, true), { value: "-50.00", currency: "CNY", negative: true });
  assert.equal(formatAmount({ commodity: "CNY", quantity: "-12.34" }), "-12.34 CNY");
});

test("余额快照只消费领域余额 DTO，保留完整中文账户名和多币种", () => {
  assert.deepEqual(snapshotFromBalance("2026-08-27", {
    range: { begin: null, end: "2026-08-28" },
    accounts: [
      { account: "Assets:C-支付宝", amounts: [{ commodity: "CNY", quantity: "12345678901234567.89" }, { commodity: "USD", quantity: "0.3" }] },
      { account: "Liabilities:C-信用卡", amounts: [{ commodity: "CNY", quantity: "-12.34" }] },
      { account: "Expenses:C-餐饮", amounts: [{ commodity: "CNY", quantity: "12.34" }] },
    ],
    totals: [],
  }), {
    asOf: "2026-08-27",
    assets: {
      accounts: [{ account: "Assets:C-支付宝", amounts: [{ commodity: "CNY", quantity: "12345678901234567.89" }, { commodity: "USD", quantity: "0.3" }] }],
      totals: [{ commodity: "CNY", quantity: "12345678901234567.89" }, { commodity: "USD", quantity: "0.3" }],
    },
    liabilities: {
      accounts: [{ account: "Liabilities:C-信用卡", amounts: [{ commodity: "CNY", quantity: "-12.34" }] }],
      totals: [{ commodity: "CNY", quantity: "-12.34" }],
    },
  });
});
