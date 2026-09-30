import { access } from "node:fs/promises";
import { join } from "node:path";
import { readBalanceSnapshot } from "./balance.js";
import { FinanceError } from "./finance/errors.js";
import { readAbsoluteDate } from "./finance/date.js";

type LiveSession = { header?: { cwd?: unknown } };
type BalanceResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: Record<string, never> } };
type RpcResult = { ok: true; value: BalanceResult };
interface HostContext {
  sessions: { get(id: string): LiveSession | undefined };
  connection: { rpc: { handle(channel: string, handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>, options: { authority: "loopback" }): () => unknown } };
  /** Cordis 内建日志服务：随 Context 必定存在，不写入 inject，直接调用。 */
  logger: { warn(message: string): void };
  /** Cordis 生命周期：注册的 disposer 随插件卸载释放。 */
  effect(callback: () => () => void, name?: string): unknown;
}

export const name = "dsh-moneypal";
export const inject = ["sessions", "connection"];

/** Web profile 的全局只读入口；Agent 工具仍由 /dsh 提供。 */
export function apply(ctx: HostContext): void {
  const disposeRpc = ctx.connection.rpc.handle("/dsh-moneypal", async (endpoint, payload, signal) => {
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
      const safe = safeError(error);
      ctx.logger.warn(`dsh-moneypal balance RPC ${safe.code}`);
      return { ok: true, value: { ok: false, error: { code: safe.code, message: safe.message, details: {} } } };
    }
  }, { authority: "loopback" });
  ctx.effect(() => disposeRpc, "dsh-moneypal.rpc()");
}

function success(value: unknown): RpcResult { return { ok: true, value: { ok: true, value } }; }

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
class BalanceRpcError extends Error { constructor(readonly code: string, message: string) { super(message); } }
function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof BalanceRpcError) return error;
  if (error instanceof FinanceError) return { code: error.code, message: error.message };
  return { code: "balance_unavailable", message: "暂时无法读取账户余额，请稍后重试。" };
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
