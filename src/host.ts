import { access } from "node:fs/promises";
import { join } from "node:path";
import { readBalanceSnapshot } from "./balance.js";
import { ledgerCandidates, probePath, type RegistryEntity, type WorkspaceRegistryView } from "./ledger-registry.js";
import { FinanceError } from "./finance/errors.js";
import { readAbsoluteDate } from "./finance/date.js";

type LiveSession = { header?: { cwd?: unknown } };
type BalanceResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, never> } };
type RpcResult = { ok: true; value: BalanceResult };
type RpcScope = "balance" | "ledger";
interface HostContext {
  sessions: { get(id: string): LiveSession | undefined };
  connection: { fetch: { register(route: { path: string; methods: string[]; requestBody: "buffered"; fetch(request: Request): Promise<Response> }): () => void | Promise<void> } };
  /** Cordis Context 服务读取入口：可选服务（workspaceRegistry 等）经此按名获取，不写入 inject。 */
  get(name: string): unknown;
  /** Cordis 内建日志服务：随 Context 必定存在，不写入 inject，直接调用。 */
  logger: { warn(message: string): void };
  /** Cordis 生命周期：注册的 disposer 随插件卸载释放。 */
  effect(callback: () => () => void | Promise<void>, name?: string): unknown;
}

export const name = "dsh-moneypal";
export const inject = ["sessions", "connection"];

/** Web profile 的全局只读入口；Agent 工具仍由 /dsh 提供。 */
export function apply(ctx: HostContext): void {
  for (const endpoint of ["capability", "balances"] as const) {
    registerRpc(ctx, `dsh-moneypal/${endpoint}`, `dsh-moneypal.${endpoint}()`, "balance", (payload, signal) => handleBalance(ctx, endpoint, payload, signal));
  }
  registerRpc(ctx, "dsh-moneypal/ledger-candidates", "dsh-moneypal.ledger-candidates()", "ledger", (payload) => handleCandidates(ctx));
  registerRpc(ctx, "dsh-moneypal/ledger-balances", "dsh-moneypal.ledger-balances()", "ledger", (payload, signal) => handleLedgerBalances(ctx, payload, signal));
}

/** 信封校验与响应封装对所有路由一致；domain 差异只在 handle 内。 */
function registerRpc(ctx: HostContext, method: string, event: string, scope: RpcScope, handle: (payload: unknown, signal: AbortSignal) => Promise<RpcResult>): void {
  ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/${method}`,
    methods: ["POST"],
    requestBody: "buffered",
    async fetch(request) {
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let message: unknown;
      try { message = await request.json(); } catch { return new Response("invalid request", { status: 400 }); }
      if (!message || typeof message !== "object" || Array.isArray(message)) return new Response("invalid request", { status: 400 });
      const envelope = message as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown };
      if (envelope.type !== "client-request" || typeof envelope.rpcId !== "string" || !envelope.rpcId || envelope.method !== method) {
        return new Response("invalid request", { status: 400 });
      }
      const result = await handle(envelope.payload, request.signal);
      return Response.json({ type: "server-response", rpcId: envelope.rpcId, result });
    },
  }), event);
}

async function handleBalance(ctx: HostContext, endpoint: "capability" | "balances", payload: unknown, signal: AbortSignal): Promise<RpcResult> {
  try {
    const request = readRequest(payload);
    const session = ctx.sessions.get(request.sessionId);
    const cwd = session?.header?.cwd;
    if (typeof cwd !== "string" || !cwd) throw new BalanceRpcError("session_unavailable", "当前会话尚未挂载账本工作区，请稍后重试。");
    if (endpoint === "capability") return success({ candidate: await exists(join(cwd, "default", "main.beancount")) });
    if (endpoint === "balances") {
      if (!request.asOf) throw new BalanceRpcError("malformed_request", "余额日期必须使用 YYYY-MM-DD 格式。");
      return success(await readBalanceSnapshot(cwd, request.asOf, signal));
    }
    throw new BalanceRpcError("malformed_request", "不支持的余额请求。");
  } catch (error) {
    return failure(ctx, error, "balance");
  }
}

/** 候选查询：不接收工作区路径或筛选条件（payload 忽略），每次调用现取注册表。
 * 服务缺失或 list 故障都是整体失败（workspace_registry_unavailable），与成功返回零个候选可区分。 */
async function handleCandidates(ctx: HostContext): Promise<RpcResult> {
  try {
    const registry = ctx.get("workspaceRegistry") as WorkspaceRegistryView | undefined;
    if (!registry || typeof registry.list !== "function") throw new BalanceRpcError("workspace_registry_unavailable", REGISTRY_UNAVAILABLE_MESSAGE);
    let entities: unknown;
    try { entities = await (registry.list as () => unknown)(); } catch { throw new BalanceRpcError("workspace_registry_unavailable", REGISTRY_UNAVAILABLE_MESSAGE); }
    return success({ candidates: await ledgerCandidates(entities) });
  } catch (error) {
    return failure(ctx, error, "ledger");
  }
}

/** 余额查询：先验证请求格式，再按 ID 重新读取登记记录，把宿主解析出的工作区交给现有余额引擎。 */
async function handleLedgerBalances(ctx: HostContext, payload: unknown, signal: AbortSignal): Promise<RpcResult> {
  try {
    const request = readLedgerRequest(payload);
    const registry = ctx.get("workspaceRegistry") as WorkspaceRegistryView | undefined;
    if (!registry || typeof registry.get !== "function") throw new BalanceRpcError("workspace_registry_unavailable", REGISTRY_UNAVAILABLE_MESSAGE);
    let entity: unknown;
    try { entity = await (registry.get as (id: string) => unknown)(request.workspaceId); } catch { throw new BalanceRpcError("workspace_registry_unavailable", REGISTRY_UNAVAILABLE_MESSAGE); }
    const workspace = (entity ?? {}) as RegistryEntity;
    const path = typeof workspace.path === "string" ? workspace.path : "";
    if (!path) throw new BalanceRpcError("workspace_not_registered", "该账本工作区已不在 DSH 登记中，请重新选择。");
    if (await probePath(path) !== "ok") throw new BalanceRpcError("workspace_unavailable", "账本工作区暂时无法访问，请稍后重试。");
    return success(await readBalanceSnapshot(path, request.asOf, signal));
  } catch (error) {
    return failure(ctx, error, "ledger");
  }
}

function success(value: unknown): RpcResult { return { ok: true, value: { ok: true, value } }; }

function failure(ctx: HostContext, error: unknown, scope: RpcScope): RpcResult {
  const safe = safeError(error);
  ctx.logger.warn(`dsh-moneypal ${scope} RPC ${safe.code}`);
  return { ok: true, value: { ok: false, error: { code: safe.code, message: safe.message, details: {} } } };
}

function readRequest(payload: unknown): { sessionId: string; asOf?: string } {
  if (!payload || typeof payload !== "object") throw new BalanceRpcError("malformed_request", "余额请求格式无效。");
  const request = payload as { sessionId?: unknown; asOf?: unknown };
  if (typeof request.sessionId !== "string" || !request.sessionId) throw new BalanceRpcError("malformed_request", "余额请求格式无效。");
  if (request.asOf !== undefined) {
    try { readAbsoluteDate(request.asOf, "余额日期"); } catch { throw new BalanceRpcError("malformed_request", "余额日期必须使用 YYYY-MM-DD 格式。"); }
  }
  if (request.asOf === undefined && request.sessionId) return { sessionId: request.sessionId };
  return { sessionId: request.sessionId, asOf: request.asOf as string };
}

function readLedgerRequest(payload: unknown): { workspaceId: string; asOf: string } {
  if (!payload || typeof payload !== "object") throw new BalanceRpcError("malformed_request", "余额请求格式无效。");
  const request = payload as { workspaceId?: unknown; asOf?: unknown };
  if (typeof request.workspaceId !== "string" || !request.workspaceId) throw new BalanceRpcError("malformed_request", "余额请求格式无效。");
  try { readAbsoluteDate(request.asOf, "余额日期"); } catch { throw new BalanceRpcError("malformed_request", "余额日期必须使用 YYYY-MM-DD 格式。"); }
  return { workspaceId: request.workspaceId, asOf: request.asOf as string };
}

const REGISTRY_UNAVAILABLE_MESSAGE = "暂时无法获取工作区列表，请稍后重试。";

class BalanceRpcError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof BalanceRpcError) return error;
  if (error instanceof FinanceError) return { code: error.code, message: error.message };
  return { code: "balance_unavailable", message: "暂时无法读取账户余额，请稍后重试。" };
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
