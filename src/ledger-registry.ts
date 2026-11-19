import { access, stat } from "node:fs/promises";
import { join } from "node:path";

/** DSH workspaceRegistry 登记记录的本地结构类型（WorkspaceEntity 的必需字段子集；
 * 0.2.2-rc.5 app.asar 实证：id、规范绝对路径 path、显示名 title）。 */
export interface RegistryEntity { id?: unknown; path?: unknown; title?: unknown; }

/** 宿主 ctx.get("workspaceRegistry") 返回的可选服务视图；方法存在性必须在运行时校验
 * （最低支持版本 0.2.1-rc.2 的形状只经上游源码核对，未经本机实证）。 */
export interface WorkspaceRegistryView { list?: unknown; get?: unknown; }

export type LedgerCandidateStatus = "candidate" | "uninitialized" | "invalid_layout" | "unavailable";
export interface LedgerCandidate { workspaceId: string; title: string; status: LedgerCandidateStatus; directoryHint?: string; }

/** 候选查询：按登记顺序对每个工作区做入口预检（只检查工作区与账本入口，完整布局校验交给余额查询的引擎），
 * 并为同名候选生成目录提示。结果绝不包含工作区绝对路径。 */
export async function ledgerCandidates(entities: unknown): Promise<LedgerCandidate[]> {
  const items: Array<{ workspaceId: string; path: string; title: string; status: LedgerCandidateStatus }> = [];
  for (const value of Array.isArray(entities) ? entities : []) {
    const entity = (value ?? {}) as RegistryEntity;
    const workspaceId = typeof entity.id === "string" ? entity.id : "";
    const path = typeof entity.path === "string" ? entity.path : "";
    if (!workspaceId || !path) continue;
    items.push({ workspaceId, path, title: displayTitle(entity, path), status: await precheckWorkspace(path) });
  }
  return withDirectoryHints(items);
}

function displayTitle(entity: RegistryEntity, path: string): string {
  if (typeof entity.title === "string" && entity.title) return entity.title;
  return path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? path;
}

/** 布局入口预检（ADR-0006/spec 候选预检结果表）：
 * 工作区或预检文件不可访问 → unavailable；default/ 未创建 → uninitialized；
 * default/ 存在但缺少 main.beancount 或入口不是常规文件 → invalid_layout；其余 → candidate。 */
async function precheckWorkspace(workspace: string): Promise<LedgerCandidateStatus> {
  if (await probePath(workspace) !== "ok") return "unavailable";
  const ledgerDirectory = await probePath(join(workspace, "default"));
  if (ledgerDirectory === "missing") return "uninitialized";
  if (ledgerDirectory !== "ok") return "unavailable";
  const entry = join(workspace, "default", "main.beancount");
  const main = await probePath(entry);
  if (main === "missing") return "invalid_layout";
  if (main !== "ok") return "unavailable";
  try { if (!(await stat(entry)).isFile()) return "invalid_layout"; } catch { return "unavailable"; }
  return "candidate";
}

/** 访问结果三态：区分 ENOENT（可判定为未创建）与其他错误（视为暂时不可访问）。 */
export async function probePath(path: string): Promise<"ok" | "missing" | "error"> {
  try { await access(path); return "ok"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error"; }
}

/** 只有同名候选需要目录提示（ADR-0006）：组内逐级上溯取首个能区分各候选的目录尾段，
 * 以 "/" 连接展示；尾段永不以分隔符开头，因此不会泄露绝对路径。 */
function withDirectoryHints(items: Array<{ workspaceId: string; path: string; title: string; status: LedgerCandidateStatus }>): LedgerCandidate[] {
  const groups = new Map<string, Array<{ workspaceId: string; path: string }>>();
  for (const item of items) {
    if (item.status !== "candidate") continue;
    const group = groups.get(item.title) ?? [];
    group.push({ workspaceId: item.workspaceId, path: item.path });
    groups.set(item.title, group);
  }
  const hints = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const [index, hint] of distinguishingTails(group.map((item) => item.path)).entries()) {
      hints.set(group[index]!.workspaceId, hint);
    }
  }
  return items.map(({ path, ...item }) => {
    const hint = hints.get(item.workspaceId);
    return hint ? { ...item, directoryHint: hint } : item;
  });
}

function distinguishingTails(paths: string[]): string[] {
  const segments = paths.map((path) => path.split(/[\\/]+/u).filter(Boolean));
  return segments.map((own, index) => {
    let size = 1;
    while (size < own.length && !tailIsUnique(segments, index, size)) size += 1;
    return own.slice(-size).join("/");
  });
}

function tailIsUnique(segments: string[][], index: number, size: number): boolean {
  const own = segments[index]!.slice(-size).join("/");
  return segments.every((other, position) => position === index || other.slice(-size).join("/") !== own);
}
