import { access, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants, ftruncateSync, writeSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FinanceError } from "./errors.js";
import { selectedPython } from "./config.js";
import { atLeastVersion } from "./version.js";

const PYPI_MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple";
const PYPI_OFFICIAL = "https://pypi.org/simple";

export interface RuntimeStatus {
  source: "managed" | "override";
  executable: string;
  available: boolean;
  pythonVersion: string | null;
  beancountVersion: string | null;
  beanqueryVersion: string | null;
  compatible: boolean;
  /** 运行时正被 setup 或账本操作占用；占用无法通过检查判断兼容性。 */
  busy: boolean;
}
export interface SetupRuntimeOptions { upgrade?: boolean; python?: string; }
export interface InspectRuntimeOptions {
  /** 只读模式：不创建锁目录、不清理失效锁，供 doctor 使用。 */
  readOnly?: boolean;
}
export interface ManagedRuntimeLocks { setup: string; use: string; }
export interface ManagedRuntimeLease { recordChild(pid: number | undefined): void; release(): Promise<void>; }

export function managedRuntimeDirectory(): string {
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "MoneyPal", "runtime");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "MoneyPal", "runtime");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "moneypal", "runtime");
}
export function managedPython(): string { return platform() === "win32" ? join(managedRuntimeDirectory(), "Scripts", "python.exe") : join(managedRuntimeDirectory(), "bin", "python"); }
export function managedRuntimeSetupLock(): string { return `${managedRuntimeDirectory()}.setup.lock`; }
export function managedRuntimeLocks(): ManagedRuntimeLocks { return { setup: managedRuntimeSetupLock(), use: `${managedRuntimeDirectory()}.use` }; }

export async function acquireManagedRuntimeLease(locks: ManagedRuntimeLocks): Promise<ManagedRuntimeLease> {
  if (await activeSetupLock(locks.setup)) throw runtimeBusy("MoneyPal 运行时正在更新；请稍后重试。");
  await mkdir(locks.use, { recursive: true, mode: 0o700 });
  const path = join(locks.use, `${process.pid}-${randomUUID()}.lock`);
  const lease = await open(path, "wx", 0o600);
  let childPid: number | undefined;
  const persist = () => { const text = JSON.stringify({ ownerPid: process.pid, childPid }); ftruncateSync(lease.fd, 0); writeSync(lease.fd, text, 0, "utf8"); };
  try { persist(); } catch (error) {
    await lease.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  const result: ManagedRuntimeLease = {
    recordChild: (pid) => { childPid = pid; persist(); },
    release: async () => { await lease.close().catch(() => undefined); await rm(path, { force: true }).catch(() => undefined); },
  };
  if (await activeSetupLock(locks.setup)) {
    await result.release();
    throw runtimeBusy("MoneyPal 运行时正在更新；请稍后重试。");
  }
  return result;
}

export async function inspectRuntime(pythonExecutable?: string, options: InspectRuntimeOptions = {}): Promise<RuntimeStatus> {
  const override = selectedPython(pythonExecutable);
  const executable = override ?? managedPython();
  const source = override ? "override" : "managed";
  if (override) return inspectExecutable(executable, source);
  const locks = managedRuntimeLocks();
  if (options.readOnly) {
    if (await runtimeIsBusy(locks, false)) return unavailable(source, executable, true);
    return inspectExecutable(executable, source);
  }
  let lease: ManagedRuntimeLease | undefined;
  try { lease = await acquireManagedRuntimeLease(locks); } catch (error) {
    if (error instanceof FinanceError && error.code === "runtime_unavailable") return unavailable(source, executable, true);
    throw error;
  }
  try { return await inspectExecutable(executable, source, lease); } finally { await lease.release(); }
}

async function inspectExecutable(executable: string, source: RuntimeStatus["source"], lease?: ManagedRuntimeLease): Promise<RuntimeStatus> {
  try { await access(executable, constants.X_OK); } catch {
    const override = source === "override";
    if (override) throw new FinanceError("invalid_configuration", "MONEYPAL_PYTHON 必须指向可执行的 Python 解释器。");
    return unavailable(source, executable);
  }
  try {
    const text = await run(executable, ["-I", "-X", "utf8", fileURLToPath(new URL("./bridge.py", import.meta.url))], JSON.stringify({ protocolVersion: 1, operation: "probe", payload: {} }), lease);
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== "object") throw new Error("invalid probe");
    const result = envelope as { protocolVersion?: unknown; runtime?: { python?: unknown; beancount?: unknown; beanquery?: unknown }; ok?: unknown; result?: { beancountAvailable?: unknown } };
    if (result.protocolVersion !== 1 || result.ok !== true || result.result?.beancountAvailable !== true || typeof result.runtime?.python !== "string" || typeof result.runtime.beancount !== "string" || typeof result.runtime.beanquery !== "string") throw new Error("invalid probe");
    const { python: pythonVersion, beancount: beancountVersion, beanquery: beanqueryVersion } = result.runtime;
    return { source, executable, available: true, pythonVersion, beancountVersion, beanqueryVersion, compatible: atLeastVersion(pythonVersion, "3.11") && atLeastVersion(beancountVersion, "3.2.3") && atLeastVersion(beanqueryVersion, "0.2.0"), busy: false };
  } catch { return unavailable(source, executable); }
}

export async function setupRuntime(options: SetupRuntimeOptions = {}): Promise<RuntimeStatus> {
  if (selectedPython()) throw new FinanceError("invalid_configuration", "设置命令不修改 MONEYPAL_PYTHON 指定的外部运行时。");
  const bootstrap = options.python;
  if (bootstrap !== undefined && (!bootstrap || !isAbsolute(bootstrap))) throw new FinanceError("invalid_configuration", "--python 必须是引导解释器的绝对路径。");
  const directory = managedRuntimeDirectory();
  const executable = managedPython();
  const locks = managedRuntimeLocks();
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const setupLock = await acquireSetupLock(locks.setup);
  try {
    if (await hasActiveRuntimeLeases(locks.use)) throw runtimeBusy("MoneyPal 运行时正被账本操作使用；请稍后重试 setup-runtime。");
    let created = false;
    try { await stat(executable); } catch {
      created = true;
      try {
        await run(bootstrap ?? (platform() === "win32" ? "py" : "python3"), ["-m", "venv", directory]);
      } catch {
        throw new FinanceError("runtime_unavailable", "MoneyPal 运行时创建失败；请检查引导解释器是否可用后重试。");
      }
    }
    const requirements = created
      ? ["beancount==3.2.3", "beanquery==0.2.0"]
      : ["beancount>=3.2.3", "beanquery>=0.2.0"];
    await installRuntimePackages(executable, requirements, options.upgrade === true);
    const status = await inspectExecutable(executable, "managed");
    if (!status.compatible) throw new FinanceError("runtime_unavailable", "MoneyPal 运行时不可用；请检查 setup-runtime 的输出后重试。");
    return status;
  } finally {
    await releaseSetupLock(locks.setup, setupLock);
  }
}

async function installRuntimePackages(executable: string, requirements: string[], upgrade: boolean): Promise<void> {
  const configured = pipRegistry();
  const attempt = async (registry: string, automatic: boolean): Promise<void> => {
    const env: NodeJS.ProcessEnv = { ...process.env, PIP_INDEX_URL: registry };
    if (automatic) env.PIP_EXTRA_INDEX_URL = "";
    await run(executable, ["-m", "pip", "install", "--timeout", "30", "--retries", "2", "--disable-pip-version-check", "--no-input", ...(automatic ? ["--extra-index-url", ""] : []), ...(upgrade ? ["--upgrade"] : []), ...requirements], undefined, undefined, env);
  };
  try {
    await attempt(configured.url, configured.automatic);
  } catch (error) {
    if (!configured.fallback || !isRetryablePipFailure(error)) throw new FinanceError("runtime_unavailable", "MoneyPal 运行时依赖安装失败；请检查网络、权限或 Python 环境后重试。");
    await attempt(PYPI_OFFICIAL, true).catch(() => { throw new FinanceError("runtime_unavailable", "MoneyPal 运行时依赖无法从国内镜像或官方源安装；请检查网络后重试。"); });
  }
}

function pipRegistry(): { url: string; automatic: boolean; fallback: boolean } {
  const special = process.env.PIP_EXTRA_INDEX_URL || process.env.PIP_FIND_LINKS || process.env.PIP_NO_INDEX;
  const direct = process.env.MONEYPAL_PYPI_INDEX_URL;
  if (direct) {
    if (special) throw new FinanceError("invalid_configuration", "MONEYPAL_PYPI_INDEX_URL 不能与高级 pip 索引配置同时使用。");
    return { url: checkedHttpUrl(direct, "MONEYPAL_PYPI_INDEX_URL"), automatic: false, fallback: false };
  }
  if (special) return { url: checkedHttpUrl(process.env.PIP_INDEX_URL ?? PYPI_OFFICIAL, "PIP_INDEX_URL"), automatic: false, fallback: false };
  if (process.env.PIP_INDEX_URL) return { url: checkedHttpUrl(process.env.PIP_INDEX_URL, "PIP_INDEX_URL"), automatic: false, fallback: false };
  return { url: PYPI_MIRROR, automatic: true, fallback: true };
}

function checkedHttpUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    return url.href.replace(/\/$/u, "");
  } catch { throw new FinanceError("invalid_configuration", `${name} 必须是有效的 HTTP(S) 地址。`); }
}

function isRetryablePipFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toUpperCase() : "";
  if (/(CERTIFICATE|AUTHENTICATION|PERMISSION|EACCES|401|403|BUILD|COMPIL)/u.test(text)) return false;
  return /(CONNECTTIMEOUT|READTIMEOUT|NEWCONNECTIONERROR|NAMERESOLUTIONERROR|NO MATCHING DISTRIBUTION|HTTP ERROR 429|HTTP ERROR 5)/u.test(text);
}

function unavailable(source: RuntimeStatus["source"], executable: string, busy = false): RuntimeStatus { return { source, executable, available: false, pythonVersion: null, beancountVersion: null, beanqueryVersion: null, compatible: false, busy }; }
/** 只读或可变地判断运行时是否被占用：setup 锁或进行中的账本租约。 */
async function runtimeIsBusy(locks: ManagedRuntimeLocks, mutate: boolean): Promise<boolean> {
  if (await activeSetupLock(locks.setup, undefined, mutate)) return true;
  return hasActiveRuntimeLeases(locks.use, mutate);
}

async function activeSetupLock(path: string, ownToken?: string, mutate = true): Promise<boolean> {
  const recovery = `${path}.recovery`;
  if (mutate) await mkdir(recovery, { recursive: true, mode: 0o700 });
  let claims: string[] = [];
  try { claims = await readdir(recovery); } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  for (const claim of claims) {
    const state = await lockState(join(recovery, claim));
    if (state.kind === "stale") { if (mutate) await rm(join(recovery, claim), { force: true }); }
    else return true;
  }
  const state = await lockState(path);
  if (state.kind !== "stale") return state.kind === "invalid" || (state.kind === "active" && state.token !== ownToken);
  if (!mutate) return false;
  const claim = join(recovery, randomUUID());
  try { await rename(path, claim); } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return activeSetupLock(path, ownToken, mutate);
    throw error;
  }
  const claimed = await lockState(claim);
  if (claimed.kind === "stale") await rm(claim, { force: true });
  return activeSetupLock(path, ownToken, mutate);
}
async function acquireSetupLock(path: string): Promise<{ handle: Awaited<ReturnType<typeof open>>; token: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await activeSetupLock(path)) throw runtimeBusy("MoneyPal 运行时正在由另一个设置进程更新；请稍后重试。");
    const token = randomUUID();
    try {
      const handle = await open(path, "wx", 0o600);
      try { writeSync(handle.fd, JSON.stringify({ ownerPid: process.pid, token }), 0, "utf8"); } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      if (await activeSetupLock(path, token)) {
        await releaseSetupLock(path, { handle, token });
        throw runtimeBusy("MoneyPal 运行时正在由另一个设置进程更新；请稍后重试。");
      }
      return { handle, token };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (attempt === 0 && !await activeSetupLock(path)) continue;
      throw runtimeBusy("MoneyPal 运行时正在由另一个设置进程更新；请稍后重试。");
    }
  }
  throw runtimeBusy("MoneyPal 运行时正在由另一个设置进程更新；请稍后重试。");
}
async function releaseSetupLock(path: string, lock: { handle: Awaited<ReturnType<typeof open>>; token: string }): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const recovery = `${path}.recovery`;
  await mkdir(recovery, { recursive: true, mode: 0o700 });
  const claim = join(recovery, `release-${lock.token}-${randomUUID()}`);
  try { await rename(path, claim); } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    return;
  }
  if ((await lockState(claim)).token === lock.token) await rm(claim, { force: true });
}
type LockState = { kind: "missing" | "invalid"; token?: undefined } | { kind: "active" | "stale"; ownerPid: number; token?: string };
async function lockState(path: string): Promise<LockState> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { ownerPid?: unknown; token?: unknown };
    if (typeof value.ownerPid !== "number" || !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0) return { kind: "invalid" };
    const token = typeof value.token === "string" ? value.token : undefined;
    return pidAlive(value.ownerPid) ? { kind: "active", ownerPid: value.ownerPid, token } : { kind: "stale", ownerPid: value.ownerPid, token };
  } catch (error) {
    return isNodeError(error) && error.code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
}
async function hasActiveRuntimeLeases(directory: string, mutate = true): Promise<boolean> {
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  for (const name of names) {
    const path = join(directory, name);
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as { ownerPid?: unknown; childPid?: unknown };
      const pids = [value.ownerPid, value.childPid].filter((pid): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0);
      if (!pids.length || pids.some(pidAlive)) return true;
      if (mutate) await rm(path, { force: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      return true;
    }
  }
  return false;
}
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return isNodeError(error) && error.code === "EPERM"; } }
function runtimeBusy(message: string): FinanceError { return new FinanceError("runtime_unavailable", message); }
function run(executable: string, args: string[], input?: string, lease?: ManagedRuntimeLease, env?: NodeJS.ProcessEnv): Promise<string> { return new Promise((resolve, reject) => { const child = spawn(executable, args, { env, shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }); let out = ""; let err = ""; child.stdout!.on("data", (v: Buffer) => { out += v.toString("utf8"); }); child.stderr!.on("data", (v: Buffer) => { err = `${err}${v.toString("utf8")}`.slice(-65536); }); child.on("error", reject); child.on("close", (code) => { if (code === 0) resolve(out.trim()); else reject(new Error(err || "runtime command failed")); }); try { lease?.recordChild(child.pid); } catch { child.kill("SIGKILL"); return reject(new Error("runtime lease failed")); } if (input !== undefined) child.stdin!.end(input); }); }
function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
