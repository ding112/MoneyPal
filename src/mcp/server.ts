import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  errorResponse,
  LEDGER_ENGINE_OPERATIONS,
  readTransactions,
  READ_ONLY_TOOL_DEFINITIONS,
  WRITE_TOOL_PARAMETERS,
  type ToolDefinition,
} from "../finance/contract.js";
import { FinanceError } from "../finance/errors.js";
import { createLedgerEngine } from "../finance/engine.js";
import { createConfirmedTransactionWriter } from "../finance/write.js";
import { BatchRegistry, type BatchUnavailableReason, type WorkspaceSource } from "./batches.js";

/** 旧版 MCP 宿主配置的账本工作区；仅供缺少新参数的客户端兼容。 */
export const WORKSPACE_ENV = "MONEYPAL_LEDGER_WORKSPACE";
/** 可选：写入预览批次的有效期（毫秒），供测试调整。 */
export const BATCH_TTL_ENV = "MONEYPAL_BATCH_TTL_MS";

const DEFAULT_BATCH_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_BATCHES = 3;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export interface McpIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  log?(message: string): void;
}

type JsonRpcId = string | number | null;
type Message = Record<string, unknown>;

interface InFlight {
  controller: AbortController;
  cancelled: boolean;
}

class JsonRpcMethodError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "JsonRpcMethodError";
  }
}

/** 在 stdio 上启动换行分隔 JSON-RPC 2.0 的 MCP 服务器；stdout 只承载协议。 */
export function startMcpServer(io: McpIo): void {
  const inFlight = new Map<string, InFlight>();
  const write = (message: unknown): void => {
    io.output.write(`${JSON.stringify(message)}\n`);
  };
  const log = (message: string): void => io.log?.(message);
  const batches = new BatchRegistry(batchTtlMs(log), MAX_PENDING_BATCHES);

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "请求不是有效的 JSON。" } });
      return;
    }
    if (!isMessage(message) || typeof message.method !== "string") {
      write({ jsonrpc: "2.0", id: messageId(message), error: { code: INVALID_REQUEST, message: "请求必须是包含 method 字段的对象。" } });
      return;
    }
    const method = message.method;
    const params = isMessage(message.params) ? message.params : {};

    if (!hasId(message)) {
      // 通知不产生响应；未知通知按 JSON-RPC 规范丢弃。
      if (method === "notifications/initialized") return;
      if (method === "notifications/cancelled") return cancelRequest(inFlight, params);
      return;
    }

    const id = readId(message.id);
    if (id === undefined) {
      write({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "请求 id 必须是字符串或数字。" } });
      return;
    }

    const pending: InFlight = { controller: new AbortController(), cancelled: false };
    const key = id === null ? "null" : String(id);
    inFlight.set(key, pending);
    try {
      const result = await dispatch(method, params, pending.controller.signal, log);
      if (!pending.cancelled) write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (!pending.cancelled) write({ jsonrpc: "2.0", id, error: toRpcError(error) });
      if (!(error instanceof JsonRpcMethodError)) log(`mcp 请求 ${method} 失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (inFlight.get(key) === pending) inFlight.delete(key);
    }
  };

  const dispatch = async (method: string, params: Message, signal: AbortSignal, log: (message: string) => void): Promise<unknown> => {
    switch (method) {
      case "initialize": {
        const protocolVersion = params.protocolVersion;
        if (typeof protocolVersion !== "string" || !protocolVersion) {
          throw new JsonRpcMethodError(INVALID_PARAMS, "initialize 必须提供 protocolVersion 字符串。");
        }
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mcp-moneypal", version: serverVersion() },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOL_DEFINITIONS.map(toMcpTool) };
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || !TOOL_DEFINITIONS.some((definition) => definition.name === name)) {
          throw new JsonRpcMethodError(INVALID_PARAMS, `未知工具：${typeof name === "string" ? name : "缺失"}。`);
        }
        const args = isMessage(params.arguments) ? params.arguments : {};
        try {
          const payload = withServerToday(await operations[name]!(args, signal));
          return { content: [{ type: "text", text: JSON.stringify(payload) }] };
        } catch (error) {
          log(`mcp 工具 ${name} 失败：${error instanceof Error ? error.name : String(error)}`);
          return { content: [{ type: "text", text: JSON.stringify(toolErrorResponse(error)) }], isError: true };
        }
      }
      default:
        throw new JsonRpcMethodError(METHOD_NOT_FOUND, `方法不存在：${method}。`);
    }
  };

  const operations: Record<string, (args: Message, signal: AbortSignal) => Promise<unknown>> = {};
  for (const definition of READ_ONLY_TOOL_DEFINITIONS) {
    const name = definition.name;
    operations[name] = async (args, signal) => {
      const workspace = await workspaceFromArguments(args);
      const payload = await LEDGER_ENGINE_OPERATIONS[name as keyof typeof LEDGER_ENGINE_OPERATIONS]!(createLedgerEngine({ ledgerWorkspace: workspace.path }), args, signal);
      return withWorkspaceSource(payload, workspace.source);
    };
  }
  operations.finance_preview_transactions = async (args, signal) => {
    const workspace = await workspaceFromArguments(args);
    const transactions = readTransactions(args);
    const writer = await createConfirmedTransactionWriter({ ledgerWorkspace: workspace.path });
    const preview = await writer.preview(transactions, signal);
    const batch = batches.register(writer, { key: workspace.key, source: workspace.source });
    return {
      batchId: batch.id,
      expiresAt: new Date(batch.expiresAt).toISOString(),
      ...preview,
      workspaceSource: workspace.source,
    };
  };
  operations.finance_commit_transactions = async (args, signal) => {
    const consumed = batches.consume(readBatchId(args));
    if (!consumed.available) {
      throw unavailableBatchError(consumed.reason);
    }
    const batchId = readBatchId(args);
    try {
      const result = await consumed.writer.commit(signal);
      batches.complete(batchId, "submitted");
      return withWorkspaceSource(result, consumed.workspaceSource);
    } catch (error) {
      batches.complete(batchId, error instanceof FinanceError && error.code === "write_outcome_uncertain" ? "outcome_uncertain" : "commit_failed");
      throw error;
    }
  };

  const readline = createInterface({ input: io.input });
  readline.on("line", (line) => {
    void handleLine(line).catch((error) => {
      log(`mcp 处理请求帧失败：${error instanceof Error ? error.message : String(error)}`);
    });
  });
  log("mcp-moneypal MCP 服务器已启动（stdio）");
}

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  ...READ_ONLY_TOOL_DEFINITIONS,
  {
    name: "finance_preview_transactions",
    description: "预览同年度普通候选交易；整批一次原子提交，返回批次号、过期时间、目标年度交易文件（transactions/<year>.beancount）及是否新建、按币种的收支汇总、与最终写入字节完全一致的规范交易文本和重复警告。使用协议：先调用本工具生成预览并把完整预览展示给用户，经用户在对话中明确确认后再调用 finance_commit_transactions 提交；未经确认不得提交。",
    parameters: WRITE_TOOL_PARAMETERS,
  },
  {
    name: "finance_commit_transactions",
    description: "提交 finance_preview_transactions 返回的交易批次，把预览的规范文本原子写入正式账本。使用协议：仅在用户对预览内容明确确认后调用；入参为预览返回的批次号，批次只能消费一次，过期或失效时须重新生成预览。",
    parameters: {
      type: "object",
      properties: {
        batchId: { type: "string", description: "preview 工具返回的交易批次号。" },
      },
      required: ["batchId"],
      additionalProperties: false,
    },
  },
];

function readBatchId(args: Message): string {
  const value = args.batchId;
  if (typeof value !== "string" || !value.trim()) throw new TypeError("batchId 必须是非空字符串");
  return value;
}

function unavailableBatchError(reason: BatchUnavailableReason): FinanceError {
  switch (reason) {
    case "expired":
      return new FinanceError("batch_expired", "交易批次已过期；请重新生成预览并再次确认后提交。");
    case "submitted":
      return new FinanceError("batch_submitted", "交易批次已经提交过；请重新生成预览并再次确认后提交。");
    case "replaced":
      return new FinanceError("batch_replaced", "交易批次已被较新的预览替换；请重新生成预览并再次确认后提交。");
    case "committing":
      return new FinanceError("batch_committing", "交易批次正在提交；请等待该次提交完成后查询正式账本。");
    case "commit_failed":
      return new FinanceError("batch_commit_failed", "交易批次提交未完成且已作废；请重新生成预览并再次确认后提交。");
    case "outcome_uncertain":
      return new FinanceError("batch_outcome_uncertain", "交易批次的写入结果不确定；请先查询正式账本，再决定是否重新生成预览。");
    case "missing":
      return new FinanceError("batch_unavailable", "交易批次不存在；请重新生成预览并再次确认后提交。");
  }
}

function batchTtlMs(log: (message: string) => void): number {
  const raw = process.env[BATCH_TTL_ENV];
  if (raw === undefined || raw === "") return DEFAULT_BATCH_TTL_MS;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  log(`环境变量 ${BATCH_TTL_ENV} 不是正数，使用默认批次有效期 ${DEFAULT_BATCH_TTL_MS} 毫秒。`);
  return DEFAULT_BATCH_TTL_MS;
}

function toMcpTool(definition: ToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.name === "finance_commit_transactions"
      ? definition.parameters
      : withLedgerWorkspaceParameter(definition.parameters),
  };
}

function withLedgerWorkspaceParameter(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = typeof parameters.properties === "object" && parameters.properties !== null
    ? parameters.properties as Record<string, unknown>
    : {};
  return {
    ...parameters,
    properties: {
      ...properties,
      ledgerWorkspace: {
        type: "string",
        description: "当前 Agent 任务的账本工作区绝对路径；其 default/ 子目录是唯一正式账本。新调用必须提供；省略仅兼容旧版环境变量配置。",
      },
    },
  };
}

interface SelectedWorkspace {
  path: string;
  key: string;
  source: WorkspaceSource;
}

async function workspaceFromArguments(args: Message): Promise<SelectedWorkspace> {
  if (Object.prototype.hasOwnProperty.call(args, "ledgerWorkspace")) {
    const workspace = args.ledgerWorkspace;
    if (typeof workspace !== "string" || !workspace.trim() || !isAbsolute(workspace)) {
      throw new FinanceError("invalid_workspace", "ledgerWorkspace 必须是当前 Agent 任务的非空绝对路径。");
    }
    return selectedWorkspace(workspace, "argument");
  }
  const legacy = process.env[WORKSPACE_ENV];
  if (typeof legacy !== "string" || !legacy.trim()) {
    throw new FinanceError(
      "invalid_workspace",
      "无法取得账本工作区；请在工具调用中传入当前 Agent 任务的 ledgerWorkspace 绝对路径。",
    );
  }
  return selectedWorkspace(legacy, "legacy_env");
}

async function selectedWorkspace(path: string, source: WorkspaceSource): Promise<SelectedWorkspace> {
  const absolute = resolve(path);
  let key = absolute;
  try {
    key = await realpath(absolute);
  } catch {
    // 布局和存在性由账本引擎返回稳定错误；此处只尽量归并路径别名。
  }
  return { path: absolute, key, source };
}

function withWorkspaceSource(payload: unknown, workspaceSource: WorkspaceSource): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) return { workspaceSource };
  return { ...(payload as Record<string, unknown>), workspaceSource };
}

/**
 * 工具错误结果的边界净化：FinanceError 的码与消息本就受控；
 * 其余未预期错误不向外暴露可能内嵌绝对路径或堆栈细节的消息。
 */
function toolErrorResponse(error: unknown): { code: string; message: string; diagnostics?: import("../finance/errors.js").ValidationDiagnostic[] } {
  if (error instanceof FinanceError) return errorResponse(error);
  if (error instanceof TypeError || error instanceof RangeError) return errorResponse(error);
  return { code: "invalid_request", message: "工具执行失败，请稍后重试。" };
}

function cancelRequest(inFlight: Map<string, InFlight>, params: Message): void {
  const requestId = params.requestId;
  if (typeof requestId !== "string" && typeof requestId !== "number") return;
  const pending = inFlight.get(String(requestId));
  if (!pending) return;
  pending.cancelled = true;
  pending.controller.abort(new FinanceError("cancelled", "请求已取消。"));
}

function withServerToday(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) return { serverToday: localToday() };
  return { ...(payload as Record<string, unknown>), serverToday: localToday() };
}

function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function toRpcError(error: unknown): { code: number; message: string } {
  if (error instanceof JsonRpcMethodError) return { code: error.code, message: error.message };
  return { code: INTERNAL_ERROR, message: "服务器内部错误。" };
}

function readId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (value === null) return null;
  return undefined;
}

function messageId(message: unknown): JsonRpcId {
  if (!isMessage(message) || !hasId(message)) return null;
  return readId(message.id) ?? null;
}

function hasId(message: Message): boolean {
  return Object.hasOwn(message, "id");
}

function isMessage(value: unknown): value is Message {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require("../../../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
