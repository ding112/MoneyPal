import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, chmod, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { READ_ONLY_TOOL_DEFINITIONS, WRITE_TOOL_PARAMETERS } from "../src/finance/contract.js";
import { inspectRuntime } from "../src/finance/runtime.js";
import { initializeLedger } from "../src/init-ledger.js";
import { apply as applyDsh } from "../src/dsh.js";

const command = fileURLToPath(new URL("../packages/mcp-moneypal/dist/src/mcp-main.js", import.meta.url));
const demoLedger = fileURLToPath(new URL("../../data/finance", import.meta.url));

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "moneypal-mcp-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createLedgerWorkspace(name: string, accounts = "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n"): Promise<string> {
  const workspace = join(root, name);
  const ledger = join(workspace, "default");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), accounts);
  await writeFile(join(ledger, "transactions", "2026.beancount"), "");
  return workspace;
}

async function validationRuntime(name: string): Promise<string> {
  const runtime = join(root, `${name}-validation-runtime.sh`);
  await writeFile(runtime, `#!/bin/sh
request=$(cat)
case "$request" in
  *'"operation":"probe"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"pythonVersion":"3.11.0","beancountVersion":"3.2.3","beanqueryVersion":"0.2.0","beancountAvailable":true}}' ;;
  *'"operation":"list_accounts"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"accounts":["Assets:C-支付宝","Liabilities:C-信用卡"]}}' ;;
  *'"operation":"balance"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"range":{"begin":null,"end":null},"accounts":[{"account":"Assets:C-支付宝","amounts":[{"commodity":"CNY","quantity":"0.3"},{"commodity":"USD","quantity":"10000000000000000"}]}],"totals":[{"commodity":"CNY","quantity":"0.3"},{"commodity":"USD","quantity":"10000000000000000"}]}}' ;;
  *'"operation":"register"'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"range":{"begin":"2026-01-01","end":"2026-02-01"},"truncated":true,"transactions":[{"date":"2026-01-02","flag":"*","payee":"商店","narration":"午餐","tags":["food"],"links":["receipt-1"],"metadata":{"receipt":"A-1"},"postings":[{"account":"Assets:C-现金","units":{"commodity":"CNY","quantity":"-12.5"},"cost":{"currency":"CNY","number":"10","date":"2026-01-01","label":null},"price":{"commodity":"USD","quantity":"2"},"flag":null,"metadata":{"note":"含税"}}]}]}}' ;;
  *) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"valid":true}}' ;;
esac
`, { mode: 0o700 });
  await chmod(runtime, 0o700);
  return runtime;
}

type RpcMessage = { id?: unknown; result?: unknown; error?: { code: number; message: string } };

class McpClient {
  readonly #child: ChildProcess;
  readonly #messages: RpcMessage[] = [];
  readonly #waiters: Array<{
    predicate: (message: RpcMessage) => boolean;
    resolve: (message: RpcMessage) => void;
    timer: NodeJS.Timeout;
  }> = [];
  readonly #stderr: string[] = [];
  #buffer = "";
  readonly #exited: Promise<unknown>;

  constructor(child: ChildProcess) {
    this.#child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.#buffer += chunk;
      for (;;) {
        const index = this.#buffer.indexOf("\n");
        if (index < 0) break;
        const line = this.#buffer.slice(0, index).trim();
        this.#buffer = this.#buffer.slice(index + 1);
        if (line) this.#receive(JSON.parse(line) as RpcMessage);
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => this.#stderr.push(chunk));
    this.#exited = new Promise((resolve) => child.on("exit", resolve));
  }

  static start(env: Record<string, string | undefined> = {}): McpClient {
    const child = spawn(process.execPath, [command], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new McpClient(child);
  }

  send(message: unknown): void {
    this.#child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(line: string): void {
    this.#child.stdin!.write(`${line}\n`);
  }

  request(id: number | string, method: string, params: unknown = {}): void {
    this.send({ jsonrpc: "2.0", id, method, params });
  }

  notify(method: string, params: unknown = {}): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async waitFor(predicate: (message: RpcMessage) => boolean, timeoutMs = 10_000): Promise<RpcMessage> {
    const index = this.#messages.findIndex(predicate);
    if (index >= 0) return this.#messages.splice(index, 1)[0]!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.#waiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.#waiters.splice(waiterIndex, 1);
        reject(new Error(`等待 MCP 响应超时（${timeoutMs}ms）；stderr：${this.#stderr.join("")}`));
      }, timeoutMs);
      this.#waiters.push({ predicate, resolve, timer });
    });
  }

  async result(id: number | string): Promise<unknown> {
    const message = await this.waitFor((candidate) => candidate.id === id && ("result" in candidate || "error" in candidate));
    assert.equal(message.error, undefined, `请求 ${id} 返回错误：${JSON.stringify(message.error)}`);
    return message.result;
  }

  /** 解析 tools/call 成功结果中的 JSON 文本负载。 */
  async payload(id: number | string): Promise<Record<string, unknown>> {
    const result = await this.result(id) as { content?: Array<{ type?: string; text?: string }> };
    const text = result?.content?.find((part) => part.type === "text")?.text;
    assert.ok(typeof text === "string", `tools/call ${id} 缺少文本负载：${JSON.stringify(result)}`);
    return JSON.parse(text) as Record<string, unknown>;
  }

  async rpcError(id: number | string): Promise<{ code: number; message: string }> {
    const message = await this.waitFor((candidate) => candidate.id === id && ("result" in candidate || "error" in candidate));
    assert.ok(message.error, `请求 ${id} 应返回 JSON-RPC 错误，实际：${JSON.stringify(message)}`);
    return message.error!;
  }

  /** 解析 tools/call 错误结果（isError: true）中的 { code, message }。 */
  async toolError(id: number | string): Promise<{ code: string; message: string }> {
    const result = await this.result(id) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    assert.equal(result?.isError, true, `tools/call ${id} 应返回工具错误结果：${JSON.stringify(result)}`);
    const text = result?.content?.find((part) => part.type === "text")?.text;
    assert.ok(typeof text === "string", `工具错误结果缺少文本负载：${JSON.stringify(result)}`);
    return JSON.parse(text) as { code: string; message: string };
  }

  receivedId(id: unknown): boolean {
    return this.#messages.some((message) => message.id === id);
  }

  async close(): Promise<void> {
    this.#child.stdin?.end();
    const outcome = await Promise.race([this.#exited.then(() => "exit"), sleep(5000).then(() => "timeout")]);
    if (outcome === "timeout") this.#child.kill("SIGKILL");
    await this.#exited;
  }

  #receive(message: RpcMessage): void {
    const waiterIndex = this.#waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = this.#waiters.splice(waiterIndex, 1);
      clearTimeout(waiter!.timer);
      waiter!.resolve(message);
      return;
    }
    this.#messages.push(message);
  }
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await sleep(25);
    }
  }
  throw new Error(`等待文件超时：${path}`);
}

async function assertProcessGone(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await sleep(25);
    } catch {
      return;
    }
  }
  throw new Error(`进程未被终止：${pid}`);
}

test("initialize 握手回显客户端 protocolVersion 并声明 tools capability", async () => {
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: demoLedger });
  try {
    client.request(1, "initialize", { protocolVersion: "2025-06-18" });
    const handshake = await client.result(1) as Record<string, unknown>;
    assert.equal(handshake.protocolVersion, "2025-06-18");
    assert.ok(typeof handshake.capabilities === "object" && handshake.capabilities !== null);
    assert.ok("tools" in (handshake.capabilities as Record<string, unknown>));
    assert.deepEqual((handshake.serverInfo as Record<string, unknown>).name, "mcp-moneypal");

    client.request(2, "initialize", { protocolVersion: "2099-01-01" });
    const upgraded = await client.result(2) as Record<string, unknown>;
    assert.equal(upgraded.protocolVersion, "2099-01-01");
  } finally {
    await client.close();
  }
});

test("ping 可达且未知方法返回标准 JSON-RPC 错误", async () => {
  const client = McpClient.start();
  try {
    client.request(1, "ping");
    assert.deepEqual(await client.result(1), {});

    client.request(2, "finance/query");
    const unknownMethod = await client.rpcError(2);
    assert.equal(unknownMethod.code, -32601);

    client.sendRaw("这不是 JSON 帧");
    const parseError = await client.waitFor((message) => message.id === null && typeof message.error === "object");
    assert.equal(parseError.error!.code, -32700);

    client.send({ jsonrpc: "2.0", id: 3 });
    const invalidRequest = await client.rpcError(3);
    assert.equal(invalidRequest.code, -32600);

    client.send({ jsonrpc: "2.0", id: true, method: "ping" });
    const invalidId = await client.waitFor((message) => message.id === null && typeof message.error === "object");
    assert.equal(invalidId.error!.code, -32600);

    client.request(4, "ping");
    assert.deepEqual(await client.result(4), {});
  } finally {
    await client.close();
  }
});

test("tools/list 返回与 DSH 同源的只读工具和两步写入工具", async () => {
  const client = McpClient.start();
  try {
    client.request(1, "tools/list");
    const listing = await client.result(1) as { tools: Array<Record<string, unknown>> };
    assert.equal(listing.tools.length, READ_ONLY_TOOL_DEFINITIONS.length + 2);
    listing.tools.forEach((tool, index) => {
      const definition = READ_ONLY_TOOL_DEFINITIONS[index];
      if (!definition) return;
      assert.equal(tool.name, definition.name);
      assert.equal(tool.description, definition.description);
      assert.deepEqual(tool.inputSchema, definition.parameters);
    });
    const withDates = listing.tools.filter((tool) => String(tool.description).includes("绝对日期"));
    assert.ok(withDates.length >= 4, "日期区间工具的描述必须要求绝对日期");

    const [preview, commit] = listing.tools.slice(READ_ONLY_TOOL_DEFINITIONS.length);
    assert.equal(preview!.name, "finance_preview_transactions");
    assert.match(String(preview!.description), /finance_commit_transactions/u);
    assert.match(String(preview!.description), /明确确认/u);
    assert.deepEqual(preview!.inputSchema, WRITE_TOOL_PARAMETERS);
    assert.equal(commit!.name, "finance_commit_transactions");
    assert.match(String(commit!.description), /确认后调用/u);
    assert.deepEqual(commit!.inputSchema, {
      type: "object",
      properties: { batchId: { type: "string", description: "preview 工具返回的交易批次号。" } },
      required: ["batchId"],
      additionalProperties: false,
    });
  } finally {
    await client.close();
  }
});

test("tools/call 对演示账本真实出数，成功响应附 serverToday", async () => {
  const workspace = join(root, "beancount-query-workspace"); const ledger = join(workspace, "default");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:C-支付宝\n2026-01-01 open Liabilities:C-信用卡\n");
  await writeFile(join(ledger, "transactions", "2026.beancount"), "");
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace, MONEYPAL_PYTHON: await validationRuntime("demo") });
  try {
    client.request(1, "tools/call", { name: "finance_list_accounts", arguments: {} });
    const accounts = await client.payload(1);
    assert.deepEqual(accounts.accounts, ["Assets:C-支付宝", "Liabilities:C-信用卡"]);
    assert.match(String(accounts.serverToday), /^\d{4}-\d{2}-\d{2}$/u);

    client.request(3, "tools/call", { name: "finance_get_balance", arguments: { account: "Assets:支付宝" } });
    const balance = await client.payload(3);
    assert.deepEqual(balance.accounts, [{ account: "Assets:C-支付宝", amounts: [{ commodity: "CNY", quantity: "0.3" }, { commodity: "USD", quantity: "10000000000000000" }] }]);
  } finally {
    await client.close();
  }
});

test("MCP 的完整流水 DTO 与 DSH 使用相同的 LedgerEngine 结构", async () => {
  const workspace = join(root, "mcp-complete-register-workspace"); const ledger = join(workspace, "default");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:C-现金\n");
  await writeFile(join(ledger, "transactions", "2026.beancount"), "");
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace, MONEYPAL_PYTHON: await validationRuntime("complete-register") });
  try {
    client.request(1, "tools/call", { name: "finance_query_register", arguments: { begin: "2026-01-01", end: "2026-02-01", text: "午餐", limit: 1 } });
    const payload = await client.payload(1); delete payload.serverToday;
    assert.deepEqual(payload, completeRegisterResult());
  } finally { await client.close(); }
});

function completeRegisterResult() {
  return { range: { begin: "2026-01-01", end: "2026-02-01" }, truncated: true, transactions: [{ date: "2026-01-02", flag: "*", payee: "商店", narration: "午餐", tags: ["food"], links: ["receipt-1"], metadata: { receipt: "A-1" }, postings: [{ account: "Assets:C-现金", units: { commodity: "CNY", quantity: "-12.5" }, cost: { currency: "CNY", number: "10", date: "2026-01-01", label: null }, price: { commodity: "USD", quantity: "2" }, flag: null, metadata: { note: "含税" } }] }] };
}

/** 真实 MoneyPal 运行时下的跨宿主验收；未安装时跳过，离线套件由上面的假运行时测试覆盖。 */
const moneypalRuntime = await inspectRuntime().catch(() => undefined);
const runtimeSkip = moneypalRuntime?.available ? false : "未检测到可用的 MoneyPal 运行时；请先执行 setup-runtime。";

test("DSH 与 MCP 对同一正式账本返回深度相等的完整流水 DTO", { skip: runtimeSkip }, async () => {
  const workspace = join(root, "cross-host-register-workspace");
  const ledger = await initializeLedger({ ledgerWorkspace: workspace, year: 2026 });
  await appendFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:C-股票\n", "utf8");
  await writeFile(join(ledger, "transactions", "2026.beancount"), `2026-01-05 * "超市" "午餐" #food ^receipt-1
  receipt: "A-1"
  Expenses:C-餐饮    12.50 CNY
    note: "含税"
  Assets:C-现金      -12.50 CNY

2026-01-06 * "券商" "买入股票"
  Assets:C-股票      10 STOCK {12 CNY, 2026-01-02, "lot-a"} @ 15 CNY
  Assets:C-现金      -120 CNY
`, "utf8");
  const arguments_ = { begin: "2026-01-01", end: "2026-02-01", account: "Assets:C-现金" };

  const definitions: Array<{ name: string; execute: (args: Record<string, unknown>, execution: unknown) => Promise<unknown> }> = [];
  applyDsh({
    tools: { register: (definition) => definitions.push(definition as unknown as { name: string; execute: (args: Record<string, unknown>, execution: unknown) => Promise<unknown> }) },
    systemPrompt: { section: () => () => undefined },
    effect: (callback) => callback(),
  });
  const register = definitions.find((definition) => definition.name === "finance_query_register");
  assert.ok(register);
  const dshResult = await register.execute(arguments_, { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal }) as { truncated: boolean; transactions: Array<{ payee: string; metadata: Record<string, unknown>; postings: Array<{ units: { commodity: string }; cost: unknown; price: unknown; metadata: Record<string, unknown> }> }> };

  // 固定账本必须真的覆盖多币种、成本、价格和 metadata，避免空结果下的空洞相等。
  assert.equal(dshResult.truncated, false);
  assert.deepEqual(dshResult.transactions.map((transaction) => transaction.payee), ["超市", "券商"]);
  assert.equal(Object.keys(dshResult.transactions[0]!.metadata).length > 0, true);
  assert.equal(Object.keys(dshResult.transactions[0]!.postings[0]!.metadata).length > 0, true);
  assert.notEqual(dshResult.transactions[1]!.postings[0]!.cost, null);
  assert.notEqual(dshResult.transactions[1]!.postings[0]!.price, null);
  assert.notEqual(dshResult.transactions[1]!.postings[0]!.units.commodity, dshResult.transactions[1]!.postings[1]!.units.commodity);

  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace });
  try {
    client.request(1, "tools/call", { name: "finance_query_register", arguments: arguments_ });
    const payload = await client.payload(1);
    delete payload.serverToday;
    assert.deepEqual(payload, dshResult);
  } finally { await client.close(); }
});

test("DSH 与 MCP 对同一正式账本返回深度相等的财务报表 DTO", { skip: runtimeSkip }, async () => {
  const workspace = join(root, "cross-host-statements-workspace");
  const ledger = await initializeLedger({ ledgerWorkspace: workspace, year: 2026 });
  await appendFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:C-美元\n", "utf8");
  await writeFile(join(ledger, "transactions", "2026.beancount"), `2026-01-05 * "雇主" "工资"
  Assets:C-现金      100 CNY
  Income:C-工资     -100 CNY

2026-01-06 * "超市" "午餐"
  Expenses:C-餐饮     20 CNY
  Assets:C-现金      -20 CNY

2026-01-07 * "店家" "办公采购"
  Expenses:C-餐饮  10 USD
  Assets:C-美元    -10 USD
`, "utf8");
  const arguments_ = { begin: "2026-01-01", end: "2026-02-01" };

  const definitions: Array<{ name: string; execute: (args: Record<string, unknown>, execution: unknown) => Promise<unknown> }> = [];
  applyDsh({
    tools: { register: (definition) => definitions.push(definition as unknown as { name: string; execute: (args: Record<string, unknown>, execution: unknown) => Promise<unknown> }) },
    systemPrompt: { section: () => () => undefined },
    effect: (callback) => callback(),
  });
  const income = definitions.find((definition) => definition.name === "finance_get_income_statement");
  const sheet = definitions.find((definition) => definition.name === "finance_get_balance_sheet");
  assert.ok(income && sheet);
  const execution = { agent: { session: { header: { cwd: workspace } } }, signal: new AbortController().signal };
  const dshIncome = await income.execute(arguments_, execution) as { netIncome: Array<{ commodity: string }> };
  const dshSheet = await sheet.execute(arguments_, execution) as { totals: { assets: Array<{ commodity: string }>; liabilitiesAndEquity: Array<{ commodity: string }> } };

  // 固定账本必须真的覆盖多币种，避免空结果下的空洞相等。
  assert.deepEqual(dshIncome.netIncome.map((amount) => amount.commodity), ["CNY", "USD"]);
  assert.deepEqual(dshSheet.totals.assets, dshSheet.totals.liabilitiesAndEquity);

  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace });
  try {
    client.request(1, "tools/call", { name: "finance_get_income_statement", arguments: arguments_ });
    const incomePayload = await client.payload(1);
    delete incomePayload.serverToday;
    assert.deepEqual(incomePayload, dshIncome);

    client.request(2, "tools/call", { name: "finance_get_balance_sheet", arguments: arguments_ });
    const sheetPayload = await client.payload(2);
    delete sheetPayload.serverToday;
    assert.deepEqual(sheetPayload, dshSheet);

    // 错误的输入也必须跨宿主返回相同 { code, message }。
    const invalid = { begin: "2026-13-01" };
    const dshError = await income.execute(invalid, execution) as { error: { code: string; message: string } };
    assert.ok(dshError.error);
    client.request(3, "tools/call", { name: "finance_get_income_statement", arguments: invalid });
    const mcpError = await client.toolError(3);
    assert.deepEqual(mcpError, dshError.error);
  } finally { await client.close(); }
});

test("MCP 的 finance_validate_journal 经 LedgerEngine 返回稳定 DTO", async () => {
  const workspace = join(root, "beancount-validation-workspace");
  const ledger = join(workspace, "default");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:Cash\n");
  await writeFile(join(ledger, "transactions", "2026.beancount"), "");
  const runtime = await validationRuntime("beancount");

  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace, MONEYPAL_PYTHON: runtime });
  try {
    client.request(1, "tools/call", { name: "finance_validate_journal", arguments: {} });
    const payload = await client.payload(1);
    assert.equal(payload.valid, true);
    assert.match(String(payload.serverToday), /^\d{4}-\d{2}-\d{2}$/u);
  } finally {
    await client.close();
  }
});

test("未配置账本工作区时返回 invalid_workspace 与环境变量指引", async () => {
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: undefined });
  try {
    client.request(1, "tools/list");
    const listing = await client.result(1) as { tools: unknown[] };
    assert.equal(listing.tools.length, READ_ONLY_TOOL_DEFINITIONS.length + 2);

    client.request(2, "tools/call", { name: "finance_list_accounts", arguments: {} });
    const error = await client.toolError(2);
    assert.equal(error.code, "invalid_workspace");
    assert.match(error.message, /MONEYPAL_LEDGER_WORKSPACE/u);
    assert.doesNotMatch(error.message, /[\r\n]/u);
  } finally {
    await client.close();
  }
});

test("工作区布局无效时返回 invalid_ledger_layout", async () => {
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: join(root, "empty-workspace") });
  try {
    client.request(1, "tools/call", { name: "finance_list_accounts", arguments: {} });
    const error = await client.toolError(1);
    assert.equal(error.code, "invalid_ledger_layout");
  } finally {
    await client.close();
  }
});

test("tools/call 未知工具返回 -32602", async () => {
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: demoLedger });
  try {
    client.request(1, "tools/call", { name: "finance_missing_tool", arguments: {} });
    const error = await client.rpcError(1);
    assert.equal(error.code, -32602);

    client.request(2, "tools/call", { arguments: {} });
    const missingName = await client.rpcError(2);
    assert.equal(missingName.code, -32602);
  } finally {
    await client.close();
  }
});

test("notifications/cancelled 中止在途请求并终止底层账本引擎子进程", async () => {
  const workspace = join(root, "cancel");
  const ledger = join(workspace, "default");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "main.beancount"), 'include "accounts.beancount"\ninclude "transactions/*.beancount"\n');
  await writeFile(join(ledger, "accounts.beancount"), "2026-01-01 open Assets:C-现金\n");
  await writeFile(join(ledger, "transactions", "2026.beancount"), "");
  const runtime = join(root, "slow-engine-runtime.sh");
  const pidFile = join(root, "slow-engine.pid");
  await writeFile(runtime, '#!/bin/sh\nprintf \'%s\\n\' "$$" > "$MONEYPAL_WRAPPER_PID_FILE"\nsleep 30\nprintf \'%s\' \'{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"valid":true}}\'\n', { mode: 0o700 });
  await chmod(runtime, 0o700);
  const client = McpClient.start({
    MONEYPAL_LEDGER_WORKSPACE: workspace,
    MONEYPAL_PYTHON: runtime,
    MONEYPAL_WRAPPER_PID_FILE: pidFile,
  });
  try {
    client.request("slow-1", "tools/call", { name: "finance_get_income_statement", arguments: {} });
    await waitForFile(pidFile);
    const pid = Number((await readFile(pidFile, "utf8")).trim());

    client.notify("notifications/cancelled", { requestId: "slow-1" });
    await assertProcessGone(pid);
    await sleep(800);
    assert.equal(client.receivedId("slow-1"), false, "被取消的请求不应再产生响应");

    client.request("after-1", "ping");
    assert.deepEqual(await client.result("after-1"), {});
  } finally {
    await client.close();
  }
});

const transaction = {
  date: "2026-08-25",
  description: "午餐",
  postings: [{ account: "Expenses:Food", amount: "12 CNY" }, { account: "Assets:Wallet" }],
};

const CANNONICAL_TEXT = '2026-08-25 * "午餐"\n  Expenses:Food   12 CNY\n  Assets:Wallet  -12 CNY\n';

/** 写入路径的托管运行时假脚本：preview 返回固定规范文本与真实加载文件列表，可按账户名模拟 undeclared_account。 */
async function writeRuntime(name: string, ledger: string): Promise<string> {
  const runtime = join(root, `${name}-write-runtime.sh`);
  const loadedFiles = [join(ledger, "main.beancount"), join(ledger, "accounts.beancount"), join(ledger, "transactions", "2026.beancount")];
  const preview = {
    validation: "passed",
    transactions: [CANNONICAL_TEXT],
    transactionText: CANNONICAL_TEXT,
    amountSummary: [{ commodity: "CNY", income: "0", expenses: "12", netIncome: "-12" }],
    duplicateWarnings: [],
    loadedFiles,
  };
  await writeFile(runtime, `#!/bin/sh
request=$(cat)
case "$request" in
  *'"operation":"preview"'*)
    case "$request" in *'Expenses:Unknown'*) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":false,"error":{"code":"undeclared_account"}}' ;; *) printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime: { python: "3.11.11", beancount: "3.2.3", beanquery: "0.2.0" }, ok: true, result: preview })}' ;; esac ;;
  *'"operation":"validate_candidates"'*) printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime: { python: "3.11.11", beancount: "3.2.3", beanquery: "0.2.0" }, ok: true, result: { valid: true, loadedFiles } })}' ;;
  *) printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"valid":true}}' ;;
esac
`, { mode: 0o700 });
  await chmod(runtime, 0o700);
  return runtime;
}

test("preview → commit 往返把规范文本原子写入年度交易文件，重复 commit 被拒", async () => {
  const workspace = await createLedgerWorkspace("write", "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  const ledger = join(workspace, "default");
  const transactionFile = join(workspace, "default", "transactions", "2026.beancount");
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace, MONEYPAL_PYTHON: await writeRuntime("roundtrip", ledger) });
  try {
    client.request(1, "tools/call", {
      name: "finance_preview_transactions",
      arguments: { transactions: [transaction, { ...transaction, date: "2026-08-26", description: "晚餐" }] },
    });
    const preview = await client.payload(1);
    assert.match(String(preview.batchId), /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/ui);
    assert.match(String(preview.expiresAt), /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(preview.targetFile, "transactions/2026.beancount");
    assert.equal(preview.createsFile, false);
    assert.equal(preview.validation, "passed");
    assert.deepEqual(preview.transactions, [CANNONICAL_TEXT]);
    assert.equal(preview.transactionText, CANNONICAL_TEXT);
    assert.deepEqual(preview.amountSummary, [{ commodity: "CNY", income: "0", expenses: "12", netIncome: "-12" }]);
    assert.deepEqual(preview.duplicateWarnings, []);
    assert.equal(await readFile(transactionFile, "utf8"), "");

    client.request(2, "tools/call", { name: "finance_commit_transactions", arguments: { batchId: preview.batchId } });
    const commit = await client.payload(2);
    assert.equal(commit.targetFile, "transactions/2026.beancount");
    assert.equal(String(commit.transactionText), CANNONICAL_TEXT);
    assert.match(String(commit.serverToday), /^\d{4}-\d{2}-\d{2}$/u);
    assert.equal(await readFile(transactionFile, "utf8"), CANNONICAL_TEXT);

    client.request(3, "tools/call", { name: "finance_commit_transactions", arguments: { batchId: preview.batchId } });
    const again = await client.toolError(3);
    assert.equal(again.code, "batch_submitted");
    assert.match(again.message, /重新生成预览/u);

    client.request(4, "tools/call", { name: "finance_commit_transactions", arguments: {} });
    const missing = await client.toolError(4);
    assert.equal(missing.code, "invalid_request");
  } finally {
    await client.close();
  }
});

test("批次过期后 commit 提示重新生成预览", async () => {
  const workspace = await createLedgerWorkspace("ttl", "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  const ledger = join(workspace, "default");
  const transactionFile = join(workspace, "default", "transactions", "2026.beancount");
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace, MONEYPAL_PYTHON: await writeRuntime("ttl", ledger), MONEYPAL_BATCH_TTL_MS: "50" });
  try {
    client.request(1, "tools/call", { name: "finance_preview_transactions", arguments: { transactions: [transaction] } });
    const preview = await client.payload(1);
    await sleep(200);

    client.request(2, "tools/call", { name: "finance_commit_transactions", arguments: { batchId: preview.batchId } });
    const error = await client.toolError(2);
    assert.equal(error.code, "batch_expired");
    assert.match(error.message, /已过期/u);
    assert.equal(await readFile(transactionFile, "utf8"), "");
  } finally {
    await client.close();
  }
});

test("待写入批次至多 3 个，超出挤出最旧", async () => {
  const workspace = await createLedgerWorkspace("cap", "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  const ledger = join(workspace, "default");
  const transactionFile = join(workspace, "default", "transactions", "2026.beancount");
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace, MONEYPAL_PYTHON: await writeRuntime("cap", ledger) });
  try {
    const batchIds: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      client.request(index + 1, "tools/call", {
        name: "finance_preview_transactions",
        arguments: { transactions: [{ ...transaction, description: `批次 ${index + 1}` }] },
      });
      const preview = await client.payload(index + 1);
      batchIds.push(preview.batchId);
    }

    client.request(10, "tools/call", { name: "finance_commit_transactions", arguments: { batchId: batchIds[0] } });
    const evicted = await client.toolError(10);
    assert.equal(evicted.code, "batch_replaced");

    client.request(11, "tools/call", { name: "finance_commit_transactions", arguments: { batchId: batchIds[3] } });
    await client.payload(11);
    assert.equal(await readFile(transactionFile, "utf8"), CANNONICAL_TEXT);
  } finally {
    await client.close();
  }
});

test("preview 后账本被改动时 commit 以 preview_stale 拒绝", async () => {
  const workspace = await createLedgerWorkspace("stale", "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  const ledger = join(workspace, "default");
  const transactionFile = join(workspace, "default", "transactions", "2026.beancount");
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace, MONEYPAL_PYTHON: await writeRuntime("stale", ledger) });
  try {
    client.request(1, "tools/call", { name: "finance_preview_transactions", arguments: { transactions: [transaction] } });
    const preview = await client.payload(1);
    assert.ok(preview.batchId);
    await writeFile(join(workspace, "default", "accounts.beancount"), "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n; changed\n");

    client.request(2, "tools/call", { name: "finance_commit_transactions", arguments: { batchId: preview.batchId } });
    const error = await client.toolError(2);
    assert.equal(error.code, "preview_stale");
    assert.equal(await readFile(transactionFile, "utf8"), "");
  } finally {
    await client.close();
  }
});

test("跨进程写入由账本锁互斥，未声明账户在预览阶段拒绝", async () => {
  const workspace = await createLedgerWorkspace("locked", "2026-01-01 open Assets:Wallet\n2026-01-01 open Expenses:Food\n");
  const ledger = join(workspace, "default");
  const transactionFile = join(workspace, "default", "transactions", "2026.beancount");
  const lockPath = join(workspace, "default", ".moneypal-write.lock");
  const client = McpClient.start({ MONEYPAL_LEDGER_WORKSPACE: workspace, MONEYPAL_PYTHON: await writeRuntime("locked", ledger) });
  try {
    client.request(1, "tools/call", { name: "finance_preview_transactions", arguments: { transactions: [transaction] } });
    const preview = await client.payload(1);

    const lock = await open(lockPath, "wx");
    try {
      client.request(2, "tools/call", { name: "finance_commit_transactions", arguments: { batchId: preview.batchId } });
      const locked = await client.toolError(2);
      assert.equal(locked.code, "ledger_locked");
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
    assert.equal(await readFile(transactionFile, "utf8"), "");

    client.request(21, "tools/call", { name: "finance_commit_transactions", arguments: { batchId: preview.batchId } });
    const failed = await client.toolError(21);
    assert.equal(failed.code, "batch_commit_failed");

    client.request(3, "tools/call", {
      name: "finance_preview_transactions",
      arguments: { transactions: [{ ...transaction, postings: [{ account: "Expenses:Unknown", amount: "12 CNY" }, { account: "Assets:Wallet" }] }] },
    });
    const undeclared = await client.toolError(3);
    assert.equal(undeclared.code, "undeclared_account");
    assert.equal(await readFile(transactionFile, "utf8"), "");
  } finally {
    await client.close();
  }
});
