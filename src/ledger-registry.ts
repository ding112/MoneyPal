import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import * as platformPath from "node:path";

const { join } = platformPath;

/** DSH workspaceRegistry 登记记录的本地结构类型（WorkspaceEntity 的必需字段子集；
 * 0.2.2-rc.5 app.asar 实证：id、规范绝对路径 path、显示名 title）。 */
export interface RegistryEntity { id?: unknown; path?: unknown; title?: unknown; }

/** 宿主 ctx.get("workspaceRegistry") 返回的可选服务视图；方法存在性必须在运行时校验
 * （最低支持版本 0.2.1-rc.2 的形状只经上游源码核对，未经本机实证）。 */
export interface WorkspaceRegistryView { list?: unknown; get?: unknown; }

export type LedgerCandidateStatus = "candidate" | "uninitialized" | "invalid_layout" | "unavailable";
export interface LedgerCandidate { workspaceId: string; title: string; status: LedgerCandidateStatus; directoryHint?: string; }

/** 预检中间记录：在对外候选（LedgerCandidate）之外额外携带宿主解析路径，仅供目录提示计算内部使用，
 * 绝不出现在候选结果中。 */
interface LedgerEntry { workspaceId: string; path: string; title: string; status: LedgerCandidateStatus; }

/** 候选查询：按登记顺序对每个工作区做入口预检（只检查工作区与账本入口，完整布局校验交给余额查询的引擎），
 * 并为同名候选生成目录提示。结果绝不包含工作区绝对路径。 */
export async function ledgerCandidates(entities: unknown): Promise<LedgerCandidate[]> {
  const items: LedgerEntry[] = [];
  for (const value of Array.isArray(entities) ? entities : []) {
    const entity = (value ?? {}) as RegistryEntity;
    const workspaceId = typeof entity.id === "string" ? entity.id : "";
    const path = typeof entity.path === "string" ? entity.path : "";
    // 缺 id/path 的畸形登记项静默跳过（不进入候选结果）是既定行为：宿主登记数据不受本插件控制，
    // 单条畸形不应使整个候选查询失败。
    if (!workspaceId || !path) continue;
    items.push({ workspaceId, path, title: displayTitle(entity, path), status: await precheckWorkspace(path) });
  }
  return withDirectoryHints(items);
}

function displayTitle(entity: RegistryEntity, path: string): string {
  if (typeof entity.title === "string" && entity.title) return entity.title;
  return platformPath.basename(path) || "Ledger";
}

/** 布局入口预检（ADR-0006/spec 候选预检结果表）：
 * 工作区或预检文件不可访问 → unavailable；default/ 未创建 → uninitialized；
 * default/ 存在但缺少 main.beancount 或入口不是常规文件 → invalid_layout；其余 → candidate。 */
async function precheckWorkspace(workspace: string): Promise<LedgerCandidateStatus> {
  const directoryAccess = constants.R_OK | constants.X_OK;
  try {
    if (!(await stat(workspace)).isDirectory()) return "unavailable";
    await access(workspace, directoryAccess);
    const directory = join(workspace, "default");
    const directoryInfo = await statIfPresent(directory);
    if (!directoryInfo) return "uninitialized";
    if (!directoryInfo.isDirectory()) return "invalid_layout";
    await access(directory, directoryAccess);
    const entry = join(directory, "main.beancount");
    if (!(await statIfPresent(entry))?.isFile()) return "invalid_layout";
    await access(entry, constants.R_OK);
    return "candidate";
  } catch {
    return "unavailable";
  }
}

async function statIfPresent(path: string) {
  try { return await stat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 余额路由用此检查登记路径是否可达，完整布局仍由余额引擎验证。 */
export async function probePath(path: string): Promise<"ok" | "missing" | "error"> {
  try { await access(path); return "ok"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error"; }
}

function withDirectoryHints(items: LedgerEntry[]): LedgerCandidate[] {
  const groups = new Map<string, Array<Pick<LedgerEntry, "workspaceId" | "path">>>();
  for (const item of items) {
    if (item.status !== "candidate") continue;
    const group = groups.get(item.title) ?? [];
    group.push({ workspaceId: item.workspaceId, path: item.path });
    groups.set(item.title, group);
  }
  const hints = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const [index, hint] of directoryHints(group).entries()) {
      hints.set(group[index]!.workspaceId, hint);
    }
  }
  return items.map(({ path, ...item }) => {
    const hint = hints.get(item.workspaceId);
    return hint ? { ...item, directoryHint: hint } : item;
  });
}

/** 仅公开无根目录尾段。整组无法区分时，改用已对外公开的工作区 ID。 */
export function directoryHints(
  group: ReadonlyArray<Pick<LedgerEntry, "workspaceId" | "path">>,
  pathApi: {
    normalize(path: string): string;
    parse(path: string): { root: string };
    sep: string;
    isAbsolute(path: string): boolean;
  } = platformPath,
): string[] {
  const segments = group.map(({ path }) => {
    const normalized = pathApi.normalize(path);
    return normalized.slice(pathApi.parse(normalized).root.length).split(pathApi.sep).filter(Boolean);
  });
  const hints = segments.map((own, index) => {
    for (let size = 1; size <= own.length; size += 1) {
      const tail = own.slice(-size).join("/");
      if (!pathApi.isAbsolute(tail) && segments.every((other, position) => position === index || other.slice(-size).join("/") !== tail)) return tail;
    }
    return undefined;
  });
  if (hints.some((hint) => hint === undefined)) return group.map(({ workspaceId }) => `#${workspaceId}`);
  return hints as string[];
}
