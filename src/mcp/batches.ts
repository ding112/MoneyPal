import { randomUUID } from "node:crypto";

import type { ConfirmedTransactionWriter } from "../finance/write.js";

export interface RegisteredBatch {
  id: string;
  /** Unix 毫秒时间戳，超过后批次不可再提交。 */
  expiresAt: number;
}

export type WorkspaceSource = "argument" | "legacy_env";

export interface BatchWorkspace {
  /** 解析符号链接后的账本工作区，用作批次容量隔离键。 */
  key: string;
  source: WorkspaceSource;
}

export type BatchUnavailableReason =
  | "missing" | "expired" | "submitted" | "replaced" | "committing" | "commit_failed" | "outcome_uncertain";

export type ConsumedBatch =
  | { available: true; writer: ConfirmedTransactionWriter; workspaceSource: WorkspaceSource }
  | { available: false; reason: BatchUnavailableReason };

/**
 * 进程内的待写入批次注册表：批次一次性消费，超过 TTL 视为过期，
 * 同一账本的待写入批次超过上限时挤出该账本最旧的批次。重启即失效，不落盘。
 */
export class BatchRegistry {
  readonly #pending = new Map<string, PendingBatch>();
  readonly #unavailable = new Map<string, BatchUnavailableReason>();

  constructor(readonly ttlMs: number, readonly maxPending: number) {}

  register(writer: ConfirmedTransactionWriter, workspace: BatchWorkspace, now = Date.now()): RegisteredBatch {
    this.#sweep(now);
    while ([...this.#pending.values()].filter((batch) => batch.workspace.key === workspace.key).length >= this.maxPending) {
      const oldest = [...this.#pending.entries()].find(([, batch]) => batch.workspace.key === workspace.key)?.[0];
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
      this.#remember(oldest, "replaced");
    }
    const id = randomUUID();
    const expiresAt = now + this.ttlMs;
    this.#pending.set(id, { writer, expiresAt, workspace });
    return { id, expiresAt };
  }

  consume(id: string, now = Date.now()): ConsumedBatch {
    const batch = this.#pending.get(id);
    if (!batch) {
      this.#sweep(now);
      return { available: false, reason: this.#unavailable.get(id) ?? "missing" };
    }
    this.#pending.delete(id);
    if (batch.expiresAt <= now) {
      this.#remember(id, "expired");
      return { available: false, reason: "expired" };
    }
    this.#remember(id, "committing");
    return { available: true, writer: batch.writer, workspaceSource: batch.workspace.source };
  }

  complete(id: string, reason: "submitted" | "commit_failed" | "outcome_uncertain"): void {
    this.#remember(id, reason);
  }

  #sweep(now: number): void {
    for (const [id, batch] of this.#pending) {
      if (batch.expiresAt <= now) {
        this.#pending.delete(id);
        this.#remember(id, "expired");
      }
    }
  }

  #remember(id: string, reason: BatchUnavailableReason): void {
    this.#unavailable.delete(id);
    this.#unavailable.set(id, reason);
    while (this.#unavailable.size > this.maxPending) {
      const oldest = this.#unavailable.keys().next().value;
      if (oldest === undefined) break;
      this.#unavailable.delete(oldest);
    }
  }
}

interface PendingBatch {
  writer: ConfirmedTransactionWriter;
  expiresAt: number;
  workspace: BatchWorkspace;
}
