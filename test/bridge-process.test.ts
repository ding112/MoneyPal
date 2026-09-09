import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runBridge } from "../src/finance/engine.js";
import { FinanceError } from "../src/finance/errors.js";
import { inspectRuntime } from "../src/finance/runtime.js";
import { selectedPython } from "../src/finance/config.js";

let root: string;
const bridge = fileURLToPath(new URL("../src/finance/bridge.py", import.meta.url));

before(async () => { root = await mkdtemp(join(tmpdir(), "moneypal-bridge-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

async function executable(name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function invoke(command: string, options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}) {
  // 默认上限只需容忍并行套件下的进程调度延迟；计时语义由显式 timeoutMs 的用例验证。
  return runBridge<{ value: string }>({ pythonExecutable: command, operationTimeoutMs: options.timeoutMs ?? 10_000, maxResultBytes: options.maxBytes ?? 1024 }, "validate", {}, options.signal);
}

function invokeRawBridge(python: string, request: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", "-X", "utf8", bridge], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    child.stdin.end(JSON.stringify(request));
  });
}

test("bridge 只接受完整、匹配版本的成功 envelope", async () => {
  const command = await executable("success", "printf '%s' '{\"protocolVersion\":1,\"runtime\":{\"python\":\"3.11.11\",\"beancount\":\"3.2.3\",\"beanquery\":\"0.2.0\"},\"ok\":true,\"result\":{\"value\":\"ok\"}}'");
  assert.deepEqual(await invoke(command), { value: "ok" });
});

test("托管运行时设置锁会阻止已创建 adapter 启动新进程", async () => {
  const command = await executable("locked-runtime", "printf '%s' '{\"protocolVersion\":1,\"runtime\":{\"python\":\"3.11.11\",\"beancount\":\"3.2.3\",\"beanquery\":\"0.2.0\"},\"ok\":true,\"result\":{\"value\":\"ok\"}}'");
  const locks = { setup: join(root, "runtime.setup.lock"), use: join(root, "runtime.use.lock") };
  await writeFile(locks.setup, "busy");
  await assert.rejects(
    runBridge({ pythonExecutable: command, operationTimeoutMs: 10_000, maxResultBytes: 1024, managedRuntimeLocks: locks }, "validate", {}),
    (error: unknown) => error instanceof FinanceError && error.code === "runtime_unavailable",
  );
});

test("托管账本操作持有使用租约直到 bridge 退出", async () => {
  const command = await executable("leased-runtime", "sleep 1; printf '%s' '{\"protocolVersion\":1,\"runtime\":{\"python\":\"3.11.11\",\"beancount\":\"3.2.3\",\"beanquery\":\"0.2.0\"},\"ok\":true,\"result\":{\"value\":\"ok\"}}'");
  const locks = { setup: join(root, "leased.setup.lock"), use: join(root, "leased.use.lock") };
  const running = runBridge<{ value: string }>({ pythonExecutable: command, operationTimeoutMs: 10_000, maxResultBytes: 1024, managedRuntimeLocks: locks }, "validate", {});
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await readdir(locks.use)).length) break; } catch { /* 租约目录尚未创建 */ }
    await delay(10);
  }
  const leases = await readdir(locks.use);
  assert.equal(leases.length, 1);
  const lease = JSON.parse(await readFile(join(locks.use, leases[0]!), "utf8")) as { ownerPid: number; childPid: number };
  assert.equal(lease.ownerPid, process.pid);
  assert.ok(Number.isSafeInteger(lease.childPid) && lease.childPid > 0);
  assert.deepEqual(await running, { value: "ok" });
  assert.deepEqual(await readdir(locks.use), []);
});

test("bridge 非零退出、畸形 JSON、缺失版本握手与协议不匹配均净化为 internal_error", async () => {
  for (const [name, body] of [
    ["nonzero", "exit 7"],
    ["malformed", "printf 'not-json'"],
    ["missing-runtime", "printf '%s' '{\"protocolVersion\":1,\"ok\":true,\"result\":{}}'"],
    ["version", "printf '%s' '{\"protocolVersion\":2,\"ok\":true,\"result\":{}}'"],
  ]) {
    const command = await executable(name, body);
    await assert.rejects(invoke(command), (error: unknown) => error instanceof FinanceError && error.code === "internal_error");
  }
});

test("bridge 每次核验 Python、Beancount 和 beanquery 最低版本", async () => {
  for (const [name, runtime] of [
    ["old-python", { python: "3.10.9", beancount: "3.2.3", beanquery: "0.2.0" }],
    ["old-beancount", { python: "3.11.11", beancount: "3.2.2", beanquery: "0.2.0" }],
    ["old-beanquery", { python: "3.11.11", beancount: "3.2.3", beanquery: "0.1.0" }],
  ] as const) {
    const command = await executable(name, `printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime, ok: true, result: { value: "no" } })}'`);
    await assert.rejects(invoke(command), (error: unknown) => error instanceof FinanceError && error.code === "runtime_unavailable");
  }
});

test("高于已验证范围的运行时在每个 Node 进程只警告一次", async () => {
  const runtime = { python: "3.15.0", beancount: "3.3.0", beanquery: "0.3.0" };
  const command = await executable("newer-runtime", `printf '%s' '${JSON.stringify({ protocolVersion: 1, runtime, ok: true, result: { value: "ok" } })}'`);
  const warnings: string[] = [];
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error) => { warnings.push(String(warning)); }) as typeof process.emitWarning;
  try {
    assert.deepEqual(await invoke(command), { value: "ok" });
    assert.deepEqual(await invoke(command), { value: "ok" });
  } finally {
    process.emitWarning = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Python 3\.15\.0.*Beancount 3\.3\.0.*beanquery 0\.3\.0/u);
});

test("bridge 将净化后的账本诊断传递为稳定错误详情", async () => {
  const command = await executable("validation-error", "printf '%s' '{\"protocolVersion\":1,\"runtime\":{\"python\":\"3.11.11\",\"beancount\":\"3.2.3\",\"beanquery\":\"0.2.0\"},\"ok\":false,\"error\":{\"code\":\"journal_invalid\",\"diagnostics\":[{\"severity\":\"error\",\"location\":{\"file\":\"accounts.beancount\",\"line\":4},\"message\":\"账本存在 Beancount 语法或会计校验错误。\",\"action\":\"请根据位置修复该指令后重新验证。\"}]}}'");
  await assert.rejects(invoke(command), (error: unknown) => {
    assert.ok(error instanceof FinanceError);
    assert.equal(error.code, "journal_invalid");
    assert.deepEqual(error.diagnostics, [{
      severity: "error",
      location: { file: "accounts.beancount", line: 4 },
      message: "账本存在 Beancount 语法或会计校验错误。",
      action: "请根据位置修复该指令后重新验证。",
    }]);
    return true;
  });
});

test("bridge 在超时、取消和超限输出时终止并返回稳定错误", async () => {
  // 用 exec 让 shell 被 sleep 替换，SIGKILL 后管道立即关闭，终止原因不会被后续计时器覆盖。
  const slow = await executable("slow", "exec sleep 2");
  await assert.rejects(invoke(slow, { timeoutMs: 20 }), (error: unknown) => error instanceof FinanceError && error.code === "operation_timeout");

  const controller = new AbortController();
  const cancelled = invoke(slow, { timeoutMs: 2_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof FinanceError && error.code === "cancelled");

  const noisy = await executable("noisy", "head -c 2048 /dev/zero");
  await assert.rejects(invoke(noisy, { maxBytes: 64 }), (error: unknown) => error instanceof FinanceError && error.code === "result_too_large");
});

test("运行时覆盖必须是可执行的绝对解释器路径", async () => {
  const nonExecutable = join(root, "not-executable");
  await writeFile(nonExecutable, "not a runtime", { mode: 0o600 });
  await assert.rejects(inspectRuntime(nonExecutable), (error: unknown) => error instanceof FinanceError && error.code === "invalid_configuration");
  assert.throws(() => {
    process.env.MONEYPAL_PYTHON = "relative-python";
    try { return selectedPython(); } finally { delete process.env.MONEYPAL_PYTHON; }
  }, FinanceError);
});

test("bridge 在导入 Beancount 前拒绝可执行指令、跨平台越界 include 和符号链接逃逸", async () => {
  const ledger = join(root, "untrusted", "default");
  const outside = join(root, "outside.beancount");
  await mkdir(join(ledger, "transactions"), { recursive: true });
  await writeFile(join(ledger, "accounts.beancount"), "");
  await writeFile(join(ledger, "transactions", "2026.beancount"), "");
  await writeFile(outside, "plugin \"danger\"\n");
  const python = process.platform === "win32" ? "python" : "python3";
  const reject = async (directive: string): Promise<void> => {
    await writeFile(join(ledger, "main.beancount"), `include "accounts.beancount"\ninclude "transactions/*.beancount"\n${directive}`);
    const response = JSON.parse(await invokeRawBridge(
      python,
      { protocolVersion: 1, operation: "validate", payload: { ledgerDirectory: ledger } },
    )) as { protocolVersion: number; runtime: Record<string, unknown>; ok: boolean; error: { code: string } };
    assert.equal(response.protocolVersion, 1);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "invalid_ledger_layout");
    assert.deepEqual(Object.keys(response.runtime).sort(), ["beancount", "beanquery", "python"]);
  };

  await reject('plugin "danger"\n');
  await reject('pythonpath "plugins"\n');
  await reject('include "/tmp/outside.beancount"\n');
  await reject('include "..\\\\outside.beancount"\n');
  await reject('include "C:\\\\outside.beancount"\n');

  if (process.platform !== "win32") {
    await symlink(outside, join(ledger, "escaped.beancount"));
    await reject('include "escaped.beancount"\n');
  }
});
