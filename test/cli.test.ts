import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const dshCommand = fileURLToPath(new URL("../src/main.js", import.meta.url));

test("DSH setup-runtime 净化引导解释器原始错误", async () => {
  const home = await mkdtemp(join(tmpdir(), "moneypal-runtime-error-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };
  delete env.MONEYPAL_PYTHON;
  try {
    const failure = await execute(process.execPath, [dshCommand, "setup-runtime", "--python", process.execPath], { env })
      .then(() => undefined, (error: unknown) => error as { code?: number; stdout?: string; stderr?: string });
    assert.equal(failure?.code, 1);
    assert.equal(failure?.stdout, "");
    assert.match(failure?.stderr ?? "", /MoneyPal 运行时创建失败/u);
    assert.doesNotMatch(failure?.stderr ?? "", /bad option|venv|runtime-error/u);
    assert.doesNotMatch(failure?.stderr ?? "", new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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

test("CLI install-preset 确认已启用 bundle 且不改写旧预设文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "moneypal-cli-preset-enabled-"));
  try {
    const profile = join(root, "profiles", "web");
    const legacyPreset = join(root, ".agent-presets", "dsh-moneypal", "agent.cordis.yml");
    await mkdir(profile, { recursive: true });
    await mkdir(join(root, ".agent-presets", "dsh-moneypal"), { recursive: true });
    const profileManifest = JSON.stringify({ dsh: { profile: { bundles: ["dsh-moneypal"] } } });
    const legacyContent = "legacy user file\n";
    await writeFile(join(profile, "package.json"), profileManifest);
    await writeFile(legacyPreset, legacyContent);

    const result = await execute(process.execPath, [dshCommand, "install-preset"], { env: { ...process.env, DSH_HOME: root } });

    assert.match(result.stdout, /随 dsh-moneypal bundle 注册/u);
    assert.equal(await readFile(join(profile, "package.json"), "utf8"), profileManifest);
    assert.equal(await readFile(legacyPreset, "utf8"), legacyContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI install-preset 未确认 bundle 时失败且不创建 profile 文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "moneypal-cli-preset-missing-"));
  try {
    const result = await execute(process.execPath, [dshCommand, "install-preset"], { env: { ...process.env, DSH_HOME: root } })
      .then(() => undefined, (error: unknown) => error as { code?: number; stderr?: string });
    assert.equal(result?.code, 1);
    assert.match(result?.stderr ?? "", /dsh plugin --profile web add dsh-moneypal/u);
    await assert.rejects(access(join(root, "profiles", "web", "package.json")));
    await assert.rejects(access(join(root, ".agent-presets", "dsh-moneypal")));
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

test("CLI uninstall-preset 只提示卸载 bundle 且不删除旧目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "moneypal-cli-preset-uninstall-"));
  try {
    const legacyPreset = join(root, ".agent-presets", "dsh-moneypal", "agent.cordis.yml");
    await mkdir(join(root, ".agent-presets", "dsh-moneypal"), { recursive: true });
    await writeFile(legacyPreset, "legacy user file\n");
    const result = await execute(process.execPath, [dshCommand, "uninstall-preset"], { env: { ...process.env, DSH_HOME: root } });
    assert.match(result.stdout, /dsh plugin --profile web remove dsh-moneypal/u);
    assert.equal(await readFile(legacyPreset, "utf8"), "legacy user file\n");
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
    await execute(process.execPath, [dshCommand, "setup-runtime", "--python", bootstrap], { env });
    let calls = await readFile(log, "utf8");
    assert.match(calls, /pip install --timeout 30 --retries 2 --disable-pip-version-check --no-input --extra-index-url\s+beancount==3\.2\.3 beanquery==0\.2\.0/u);

    await rm(runtimeDirectory, { recursive: true, force: true });
    await rm(log, { force: true });
    await execute(process.execPath, [dshCommand, "setup-runtime", "--upgrade", "--python", bootstrap], { env });
    calls = await readFile(log, "utf8");
    assert.match(calls, /pip install --timeout 30 --retries 2 --disable-pip-version-check --no-input --extra-index-url\s+--upgrade beancount==3\.2\.3 beanquery==0\.2\.0/u);

    await writeFile(`${runtimeDirectory}.setup.lock`, "busy", { flag: "wx" });
    const status = JSON.parse((await execute(process.execPath, [dshCommand, "runtime-status"], { env })).stdout) as { available: boolean; compatible: boolean };
    assert.deepEqual({ available: status.available, compatible: status.compatible }, { available: false, compatible: false });
    await assert.rejects(
      execute(process.execPath, [dshCommand, "setup-runtime"], { env }),
      (error: unknown) => error instanceof Error && "stderr" in error && /\u6b63在由另一个设置进程更新/u.test(String(error.stderr)),
    );
    await rm(`${runtimeDirectory}.setup.lock`, { force: true });
    await mkdir(`${runtimeDirectory}.use`, { recursive: true });
    await writeFile(join(`${runtimeDirectory}.use`, "active.lock"), JSON.stringify({ ownerPid: process.pid }), { flag: "wx" });
    await assert.rejects(
      execute(process.execPath, [dshCommand, "setup-runtime"], { env }),
      (error: unknown) => error instanceof Error && "stderr" in error && /\u6b63被账本操作使用/u.test(String(error.stderr)),
    );
    await rm(`${runtimeDirectory}.use`, { recursive: true, force: true });
    await writeFile(`${runtimeDirectory}.setup.lock`, JSON.stringify({ ownerPid: 2_147_483_647 }), { flag: "wx" });
    const recovered = JSON.parse((await execute(process.execPath, [dshCommand, "setup-runtime"], { env })).stdout) as { available: boolean; compatible: boolean };
    assert.deepEqual({ available: recovered.available, compatible: recovered.compatible }, { available: true, compatible: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
