import assert from "node:assert/strict";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { apply } from "../src/dsh.js";
import { omitSchemaDescriptions } from "./contract-fixtures.js";

let root: string; let engineRuntime: string; let originalPython: string | undefined;

type PromptSection = { name: string; order: number; text: string | (() => string) };
type Definition = { name: string; timeoutMs?: number; execute: (args: unknown, exec: unknown) => Promise<unknown> };
type QuestionRequest = { questions: Array<{ id: string; question: string; detail?: string; header?: string; options: Array<{ label: string; description: string }>; intent?: { kind: "plan-review"; approve: string } }> };

function applyPlugin(definitions: Definition[], sections: PromptSection[], userQuestions?: { ask: (request: QuestionRequest) => Promise<{ answers: Array<{ id: string; selected: string[] }> }> }): void {
  apply({
    tools: { register: (definition) => definitions.push(definition as unknown as Definition) },
    systemPrompt: { section: (section) => { sections.push(section); return () => undefined; } },
    effect: (callback) => callback(),
    ...(userQuestions ? { userQuestions } : {}),
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "dsh-moneypal-dsh-"));
  engineRuntime = join(root, "engine-runtime.sh");
  await writeFile(engineRuntime, `#!/bin/sh
request=$(cat)
case "$request" in *'"operation":"list_accounts"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"accounts":["Assets:C-钱包"]}}' ;; *'"text":"午餐"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"range":{"begin":"2026-01-01","end":"2026-02-01"},"truncated":true,"transactions":[{"date":"2026-01-02","flag":"*","payee":"商店","narration":"午餐","tags":["food"],"links":["receipt-1"],"metadata":{"receipt":"A-1"},"postings":[{"account":"Assets:C-现金","units":{"commodity":"CNY","quantity":"-12.5"},"cost":{"currency":"CNY","number":"10","date":"2026-01-01","label":null},"price":{"commodity":"USD","quantity":"2"},"flag":null,"metadata":{"note":"含税"}}]}]}}' ;; *'"operation":"register"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"range":{"begin":null,"end":null},"truncated":false,"transactions":[]}}' ;; *'"operation":"balance"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"range":{"begin":null,"end":null},"accounts":[],"totals":[]}}' ;; *) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"valid":true}}' ;; esac
`, { mode: 0o700 });
  await chmod(engineRuntime, 0o700); originalPython = process.env.MONEYPAL_PYTHON; process.env.MONEYPAL_PYTHON = engineRuntime;
});

after(async () => {
  if (originalPython === undefined) delete process.env.MONEYPAL_PYTHON; else process.env.MONEYPAL_PYTHON = originalPython;
  await rm(root, { recursive: true, force: true });
});

test("DSH 注册六个稳定的只读工具、受确认保护的写入和初始化工具", async () => {
  const workspace = join(root, "workspace");
  const ledger = join(workspace, "default");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:C-钱包\n");
  await writeFile(join(ledger, "transactions", "2026.beancount"), "");

  const definitions: Definition[] = [];
  const sections: PromptSection[] = [];
  applyPlugin(definitions, sections);

  assert.deepEqual(definitions.map((definition) => definition.name), [
    "finance_query_register",
    "finance_get_balance",
    "finance_get_income_statement",
    "finance_get_balance_sheet",
    "finance_list_accounts",
    "finance_validate_journal",
    "finance_add_transactions",
    "finance_initialize_ledger",
  ]);
  for (const definition of definitions) {
    const schema = (definition as unknown as { parameters: { type?: unknown } }).parameters;
    assert.equal(schema.type, "object", `${definition.name} 必须注册为 object JSON Schema`);
  }
  assert.equal(definitions.find((definition) => definition.name === "finance_add_transactions")?.timeoutMs, undefined);
  assert.equal(definitions.find((definition) => definition.name === "finance_query_register")?.timeoutMs, 30_000);
  assert.deepEqual(
    omitSchemaDescriptions((definitions.find((definition) => definition.name === "finance_initialize_ledger") as unknown as { parameters: unknown }).parameters),
    omitSchemaDescriptions({ type: "object", properties: {}, additionalProperties: false }),
  );
  assert.deepEqual(
    omitSchemaDescriptions((definitions.find((definition) => definition.name === "finance_add_transactions") as unknown as { parameters: unknown }).parameters),
    omitSchemaDescriptions({
      type: "object",
      properties: {
        transactions: {
          type: "array",
          description: "同一自然年的普通候选交易；整批一次预览、一次确认、一次原子提交。",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              date: { type: "string", description: "交易日期，YYYY-MM-DD。" },
              description: { type: "string", description: "交易说明（成为 Beancount narration），非空单行文本。" },
              postings: {
                type: "array",
                description: "至少两个分录；最多一个分录可省略 amount，由 Beancount booking 推导平衡金额。",
                minItems: 2,
                items: {
                  type: "object",
                  properties: {
                    account: { type: "string", description: "已在 accounts.beancount 中声明的账户名称。" },
                    amount: { type: "string", description: "可选金额，格式如 286 CNY 或 -12.50 USD；整笔交易只能使用一种商品。" },
                  },
                  required: ["account"],
                  additionalProperties: false,
                },
              },
            },
            required: ["date", "description", "postings"],
            additionalProperties: false,
          },
        },
      },
      required: ["transactions"],
      additionalProperties: false,
    }),
  );

  const accounts = definitions.find((definition) => definition.name === "finance_list_accounts");
  assert.ok(accounts);
  assert.deepEqual(
    await accounts.execute({}, { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal }),
    { accounts: ["Assets:C-钱包"] },
  );

  assert.deepEqual(sections.map((section) => section.name), ["dsh-moneypal:date-defaults"]);
});

test("DSH 适配器将空流水和空余额包装为对象输出", async () => {
  const workspace = join(root, "empty-query-workspace");
  const ledger = join(workspace, "default");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:C-钱包\n");
  await writeFile(join(ledger, "transactions", "2026.beancount"), "");

  const definitions: Definition[] = [];
  applyPlugin(definitions, []);
  const execution = { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal };
  const register = definitions.find((definition) => definition.name === "finance_query_register");
  const balance = definitions.find((definition) => definition.name === "finance_get_balance");
  assert.ok(register);
  assert.ok(balance);

  assert.deepEqual(await register.execute({}, execution), { range: { begin: null, end: null }, truncated: false, transactions: [] });
  assert.deepEqual(await balance.execute({}, execution), { range: { begin: null, end: null }, accounts: [], totals: [] });
});

const CANNONICAL_LUNCH = '2026-08-25 * "午餐"\n  Expenses:Food   12 CNY\n  Assets:Wallet  -12 CNY\n';

/** 写入路径的托管运行时假脚本：probe/preview/validate_candidates 返回固定结果，loadedFiles 指向真实账本文件。 */
async function writeFake(name: string, ledger: string, result: { transactions: string[]; transactionText: string; amountSummary: Array<Record<string, string>>; duplicateWarnings: unknown[] }): Promise<string> {
  const runtime = join(root, `${name}-write-runtime.sh`);
  const loadedFiles = [join(ledger, "main.beancount"), join(ledger, "accounts.beancount"), join(ledger, "transactions", "2026.beancount")];
  const preview = { validation: "passed", ...result, loadedFiles };
  await writeFile(runtime, `#!/bin/sh
request=$(cat)
case "$request" in
  *'"operation":"probe"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"pythonVersion":"3.11.0","beancountVersion":"3.2.3","beanqueryVersion":"0.2.0","beancountAvailable":true}}' ;;
  *'"operation":"preview"'*) printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime: { python: "3.11.11", beancount: "3.2.3", beanquery: "0.2.0" }, ok: true, result: preview })}' ;;
  *'"operation":"validate_candidates"'*) printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime: { python: "3.11.11", beancount: "3.2.3", beanquery: "0.2.0" }, ok: true, result: { valid: true, loadedFiles } })}' ;;
  *) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"valid":true}}' ;;
esac
`, { mode: 0o700 });
  await chmod(runtime, 0o700);
  return runtime;
}

async function withPython(runtime: string, action: () => Promise<void>): Promise<void> {
  const original = process.env.MONEYPAL_PYTHON;
  process.env.MONEYPAL_PYTHON = runtime;
  try { await action(); } finally {
    if (original === undefined) delete process.env.MONEYPAL_PYTHON;
    else process.env.MONEYPAL_PYTHON = original;
  }
}

test("根 Agent 确认后写入交易，子 Agent 不会写入", async () => {
  const workspace = join(root, "write-workspace");
  const ledger = join(workspace, "default");
  const transactionFile = join(ledger, "transactions", "2026.beancount");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  await writeFile(transactionFile, "");

  const definitions: Definition[] = [];
  let confirmation: QuestionRequest | undefined;
  applyPlugin(definitions, [], { ask: async (request) => {
    confirmation = request;
    return { answers: [{ id: "confirm_finance_write", selected: ["记入"] }] };
  } });
  const add = definitions.find((definition) => definition.name === "finance_add_transactions");
  assert.ok(add);
  const args = { transactions: [{ date: "2026-08-25", description: "午餐", postings: [{ account: "Expenses:Food", amount: "12 CNY" }, { account: "Assets:Wallet" }] }] };
  const runtime = await writeFake("root-write", ledger, {
    transactions: [CANNONICAL_LUNCH],
    transactionText: CANNONICAL_LUNCH,
    amountSummary: [{ commodity: "CNY", income: "0", expenses: "12", netIncome: "-12" }],
    duplicateWarnings: [],
  });
  await withPython(runtime, async () => {
    const rootResult = await add.execute(args, { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal });
    assert.deepEqual(rootResult, {
      targetFile: "transactions/2026.beancount",
      transactions: [CANNONICAL_LUNCH],
      transactionText: CANNONICAL_LUNCH,
    });
  });
  assert.equal(await (await import("node:fs/promises")).readFile(transactionFile, "utf8"), CANNONICAL_LUNCH);
  assert.deepEqual(confirmation?.questions, [{
      id: "confirm_finance_write",
      question: "确认执行这份记账计划吗？",
      detail: `共 **1** 笔交易。\n\n## 收支汇总\n\n| 币种 | 收入 | 支出 | 净额 |\n| --- | ---: | ---: | ---: |\n| CNY | 0 | 12 | -12 |\n\n## 交易明细\n\n\`\`\`text\n${CANNONICAL_LUNCH.trimEnd()}\n\`\`\``,
      options: [
        { label: "记入", description: "按以上内容记账。" },
        { label: "取消", description: "不写入账本，可修改后重试。" },
      ],
      intent: { kind: "plan-review", approve: "记入" },
    }]);

  const childResult = await add.execute(args, { agent: { session: { header: { cwd: workspace, parentSession: "parent" } } }, signal: new AbortController().signal });
  assert.deepEqual(childResult, { error: { code: "write_requires_root_agent", message: "子 Agent 不能写入正式账本；请将候选交易交回根 Web Agent 以生成预览并确认。" } });
});

test("整份提交只确认一次，不按数量隐式切分", async () => {
  const workspace = join(root, "no-chunk-workspace");
  const ledger = join(workspace, "default");
  const transactionFile = join(ledger, "transactions", "2026.beancount");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  await writeFile(transactionFile, "");

  const definitions: Definition[] = [];
  let confirmationCount = 0;
  applyPlugin(definitions, [], { ask: async () => {
    confirmationCount += 1;
    return { answers: [{ id: "confirm_finance_write", selected: ["记入"] }] };
  } });
  const add = definitions.find((definition) => definition.name === "finance_add_transactions");
  assert.ok(add);
  const transactions = Array.from({ length: 101 }, (_, index) => ({
    date: "2026-08-25",
    description: `餐费 ${index + 1}`,
    postings: [{ account: "Expenses:Food", amount: "12 CNY" }, { account: "Assets:Wallet" }],
  }));
  const runtime = await writeFake("no-chunk", ledger, {
    transactions: [CANNONICAL_LUNCH],
    transactionText: CANNONICAL_LUNCH,
    amountSummary: [{ commodity: "CNY", income: "0", expenses: "12", netIncome: "-12" }],
    duplicateWarnings: [],
  });
  await withPython(runtime, async () => {
    const result = await add.execute({ transactions }, { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal });
    assert.equal(confirmationCount, 1);
    assert.deepEqual((result as { transactions: string[] }).transactions, [CANNONICAL_LUNCH]);
  });
  assert.equal(await (await import("node:fs/promises")).readFile(transactionFile, "utf8"), CANNONICAL_LUNCH);
});

test("取消确认框时不修改正式账本", async () => {
  const workspace = join(root, "cancel-workspace");
  const ledger = join(workspace, "default");
  const transactionFile = join(ledger, "transactions", "2026.beancount");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  await writeFile(transactionFile, "");
  const definitions: Definition[] = [];
  applyPlugin(definitions, [], { ask: async () => ({ answers: [{ id: "confirm_finance_write", selected: ["取消"] }] }) });
  const add = definitions.find((definition) => definition.name === "finance_add_transactions");
  assert.ok(add);
  const runtime = await writeFake("cancel-confirm", ledger, {
    transactions: [CANNONICAL_LUNCH],
    transactionText: CANNONICAL_LUNCH,
    amountSummary: [{ commodity: "CNY", income: "0", expenses: "12", netIncome: "-12" }],
    duplicateWarnings: [],
  });
  await withPython(runtime, async () => {
    assert.deepEqual(
      await add.execute({ transactions: [{ date: "2026-08-25", description: "午餐", postings: [{ account: "Expenses:Food", amount: "12 CNY" }, { account: "Assets:Wallet" }] }] }, { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal }),
      { error: { code: "cancelled", message: "已取消写入，正式账本未修改。" } },
    );
  });
  assert.equal(await (await import("node:fs/promises")).readFile(transactionFile, "utf8"), "");
});

test("DSH 适配器把缺少工作区转换为结构化错误", async () => {
  const definitions: Definition[] = [];
  applyPlugin(definitions, []);
  const accounts = definitions.find((definition) => definition.name === "finance_list_accounts");
  assert.ok(accounts);

  assert.deepEqual(
    await accounts.execute({}, { agent: { session: { header: {} } }, signal: new AbortController().signal }),
    { error: { code: "invalid_workspace", message: "无法取得调用所属的账本工作区；请在 DSH Web 中打开账本工作区后重试。" } },
  );

  const initialize = definitions.find((definition) => definition.name === "finance_initialize_ledger");
  assert.ok(initialize);
  assert.deepEqual(
    await initialize.execute({}, { agent: { session: { header: {} } }, signal: new AbortController().signal }),
    { error: { code: "invalid_workspace", message: "无法取得调用所属的账本工作区；请在 DSH Web 中打开账本工作区后重试。" } },
  );
});

test("根 Agent 确认后初始化账本，并只返回相对路径", async () => {
  const workspace = join(root, "initialize-workspace");
  const definitions: Definition[] = [];
  let confirmation: QuestionRequest | undefined;
  applyPlugin(definitions, [], { ask: async (request) => {
    confirmation = request;
    return { answers: [{ id: "confirm_ledger_initialization", selected: ["初始化"] }] };
  } });
  const initialize = definitions.find((definition) => definition.name === "finance_initialize_ledger");
  assert.ok(initialize);
  const year = new Date().getFullYear();
  const result = await initialize.execute({}, { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal });
  const expected = {
    initialized: true,
    ledgerDirectory: "default",
    year,
    files: ["default/accounts.beancount", `default/transactions/${year}.beancount`, "default/main.beancount"],
    accounts: ["Assets:C-现金", "Liabilities:C-信用卡", "Equity:C-期初余额", "Expenses:C-餐饮", "Income:C-工资"],
  };
  assert.deepEqual(result, expected);
  assert.equal(JSON.stringify(result).includes(workspace), false);
  assert.equal(await readFile(join(workspace, "default", "transactions", `${year}.beancount`), "utf8"), "");
  assert.match(confirmation?.questions[0]?.detail ?? "", new RegExp(`\\*\\*${year}\\*\\* 年账本`, "u"));
  assert.match(confirmation?.questions[0]?.detail ?? "", /default\/main\.beancount/u);
  assert.match(confirmation?.questions[0]?.detail ?? "", /Assets:C-现金/u);
});

test("初始化确认取消、子 Agent 和已有账本均不写入", async () => {
  const cancelled = join(root, "initialize-cancelled");
  const definitions: Definition[] = [];
  let prompts = 0;
  applyPlugin(definitions, [], { ask: async () => {
    prompts += 1;
    return { answers: [{ id: "confirm_ledger_initialization", selected: ["取消"] }] };
  } });
  const initialize = definitions.find((definition) => definition.name === "finance_initialize_ledger");
  assert.ok(initialize);
  const execution = { agent: { session: { header: { cwd: cancelled } } }, signal: new AbortController().signal };
  assert.deepEqual(
    await initialize.execute({}, execution),
    { error: { code: "cancelled", message: "已取消初始化，工作区未修改。" } },
  );
  await assert.rejects(access(join(cancelled, "default")));

  assert.deepEqual(
    await initialize.execute({}, { agent: { session: { header: { cwd: cancelled, parentSession: "parent" } } }, signal: new AbortController().signal }),
    { error: { code: "write_requires_root_agent", message: "子 Agent 不能初始化账本；请交由根 Web Agent 发起并确认。" } },
  );
  assert.equal(prompts, 1);

  const existing = join(root, "initialize-existing");
  await mkdir(join(existing, "default"), { recursive: true });
  assert.deepEqual(
    await initialize.execute({}, { agent: { session: { header: { cwd: existing } } }, signal: new AbortController().signal }),
    { error: { code: "ledger_already_initialized", message: "账本已存在；为避免覆盖，初始化已取消。" } },
  );
  assert.equal(prompts, 1);
});
