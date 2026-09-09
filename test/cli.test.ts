import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { managedPresetPath, standardPreset } from "./preset-fixtures.js";

const execute = promisify(execFile);
const dshCommand = fileURLToPath(new URL("../packages/dsh-moneypal/dist/src/main.js", import.meta.url));
const localDshCommand = fileURLToPath(new URL("../src/main.js", import.meta.url));
const mcpCommand = fileURLToPath(new URL("../packages/mcp-moneypal/dist/src/mcp-main.js", import.meta.url));

test("DSH CLI 不再启动 MCP 服务器", async () => {
  await assert.rejects(
    execute(process.execPath, [dshCommand, "mcp"]),
    (error: unknown) => error instanceof Error
      && "stderr" in error
      && typeof error.stderr === "string"
      && /用法：dsh-moneypal/u.test(error.stderr),
  );
});

test("MCP CLI 不提供 DSH 预设安装命令", async () => {
  await assert.rejects(
    execute(process.execPath, [mcpCommand, "install-preset"]),
    (error: unknown) => error instanceof Error
      && "stderr" in error
      && typeof error.stderr === "string"
      && /用法：mcp-moneypal/u.test(error.stderr),
  );
});

test("CLI init 初始化指定账本工作区", async () => {
  const root = await mkdtemp(join(tmpdir(), "moneypal-cli-"));
  try {
    const workspace = join(root, "ledger");
    const result = await execute(process.execPath, [dshCommand, "init", workspace]);

    assert.match(result.stdout, /账本已初始化/u);
    assert.equal(
      await readFile(join(workspace, "default", "main.beancount"), "utf8"),
      'include "accounts.beancount"\ninclude "transactions/*.beancount"\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI init 默认初始化当前工作区", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "moneypal-cli-cwd-"));
  try {
    await execute(process.execPath, [dshCommand, "init"], { cwd: workspace });

    assert.equal(
      await readFile(join(workspace, "default", "transactions", `${new Date().getFullYear()}.beancount`), "utf8"),
      "",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("本地 CLI 安装预设时使用 DSH 包名而非根工作区包名", async () => {
  const root = await mkdtemp(join(tmpdir(), "moneypal-cli-install-preset-"));
  try {
    await standardPreset(root);

    await execute(process.execPath, [localDshCommand, "install-preset"], {
      env: { ...process.env, DSH_HOME: root },
    });

    const preset = await readFile(join(managedPresetPath(root), "agent.cordis.yml"), "utf8");
    assert.match(preset, /name: "dsh-moneypal\/dsh"/u);
    assert.doesNotMatch(preset, /name: "moneypal-workspace\/dsh"/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH CLI 用法列出卸载命令并拒绝多余参数", async () => {
  await assert.rejects(
    execute(process.execPath, [dshCommand, "uninstall-preset", "extra"]),
    (error: unknown) => error instanceof Error
      && "stderr" in error
      && typeof error.stderr === "string"
      && /用法：dsh-moneypal <install-preset \| uninstall-preset/u.test(error.stderr),
  );
});

test("CLI uninstall-preset 移除托管预设并可重复执行", async () => {
  const root = await mkdtemp(join(tmpdir(), "moneypal-cli-uninstall-preset-"));
  try {
    await standardPreset(root);
    const env = { ...process.env, DSH_HOME: root };
    await execute(process.execPath, [localDshCommand, "install-preset"], { env });

    const removed = await execute(process.execPath, [localDshCommand, "uninstall-preset"], { env });
    assert.match(removed.stdout, /已移除托管预设/u);
    await assert.rejects(access(managedPresetPath(root)));

    const again = await execute(process.execPath, [localDshCommand, "uninstall-preset"], { env });
    assert.match(again.stdout, /无需卸载/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI uninstall-preset 拒绝删除没有托管标记的预设", async () => {
  const root = await mkdtemp(join(tmpdir(), "moneypal-cli-uninstall-collision-"));
  try {
    const target = managedPresetPath(root);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "agent.cordis.yml"), "- id: user\n  name: user-plugin\n");

    await assert.rejects(
      execute(process.execPath, [localDshCommand, "uninstall-preset"], { env: { ...process.env, DSH_HOME: root } }),
      (error: unknown) => error instanceof Error
        && "stderr" in error
        && typeof error.stderr === "string"
        && /不会删除/u.test(error.stderr),
    );
    assert.equal(await readFile(join(target, "agent.cordis.yml"), "utf8"), "- id: user\n  name: user-plugin\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup-runtime 首次创建钉定验证基线，并对并发设置受控退出", { skip: process.platform === "win32" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "moneypal-runtime-home-"));
  const bootstrap = join(home, "bootstrap.mjs");
  const log = join(home, "setup.log");
  const runtimeDirectory = process.platform === "darwin"
    ? join(home, "Library", "Application Support", "MoneyPal", "runtime")
    : join(home, ".local", "share", "moneypal", "runtime");
  await writeFile(bootstrap, `#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const directory = process.argv.at(-1);
mkdirSync(join(directory, "bin"), { recursive: true });
writeFileSync(join(directory, "bin", "python"), \`#!/bin/sh
printf '%s\\n' "$*" >> "$MONEYPAL_SETUP_LOG"
case "$*" in *bridge.py*) cat >/dev/null; printf '%s' '{"protocolVersion":1,"runtime":{"python":"3.11.11","beancount":"3.2.3","beanquery":"0.2.0"},"ok":true,"result":{"pythonVersion":"3.11.11","beancountVersion":"3.2.3","beanqueryVersion":"0.2.0","beancountAvailable":true}}' ;; esac
\`, { mode: 0o700 });
chmodSync(join(directory, "bin", "python"), 0o700);
`, { mode: 0o700 });
  await chmod(bootstrap, 0o700);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, MONEYPAL_SETUP_LOG: log };
  delete env.MONEYPAL_PYTHON;
  try {
    await execute(process.execPath, [localDshCommand, "setup-runtime", "--python", bootstrap], { env });
    let calls = await readFile(log, "utf8");
    assert.match(calls, /pip install beancount==3\.2\.3 beanquery==0\.2\.0/u);

    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(log, { force: true });
    await execute(process.execPath, [localDshCommand, "setup-runtime", "--upgrade", "--python", bootstrap], { env });
    calls = await readFile(log, "utf8");
    assert.match(calls, /pip install --upgrade beancount==3\.2\.3 beanquery==0\.2\.0/u);

    await writeFile(`${runtimeDirectory}.setup.lock`, "busy", { flag: "wx" });
    const status = JSON.parse((await execute(process.execPath, [localDshCommand, "runtime-status"], { env })).stdout) as { available: boolean; compatible: boolean };
    assert.deepEqual({ available: status.available, compatible: status.compatible }, { available: false, compatible: false });
    await assert.rejects(
      execute(process.execPath, [localDshCommand, "setup-runtime"], { env }),
      (error: unknown) => error instanceof Error && "stderr" in error && /\u6b63在由另一个设置进程更新/u.test(String(error.stderr)),
    );
    await rm(`${runtimeDirectory}.setup.lock`, { force: true });
    await mkdir(`${runtimeDirectory}.use`, { recursive: true });
    await writeFile(join(`${runtimeDirectory}.use`, "active.lock"), JSON.stringify({ ownerPid: process.pid }), { flag: "wx" });
    await assert.rejects(
      execute(process.execPath, [localDshCommand, "setup-runtime"], { env }),
      (error: unknown) => error instanceof Error && "stderr" in error && /\u6b63被账本操作使用/u.test(String(error.stderr)),
    );
    await rm(`${runtimeDirectory}.use`, { recursive: true, force: true });
    await writeFile(`${runtimeDirectory}.setup.lock`, JSON.stringify({ ownerPid: 2_147_483_647 }), { flag: "wx" });
    const recovered = JSON.parse((await execute(process.execPath, [localDshCommand, "setup-runtime"], { env })).stdout) as { available: boolean; compatible: boolean };
    assert.deepEqual({ available: recovered.available, compatible: recovered.compatible }, { available: true, compatible: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
