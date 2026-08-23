import type { Firestore } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";

/**
 * quizツール呼び出しの監査ログ。ルートコレクション `mcp_audit_logs`（TTLなし=
 * 監査ログは自動削除しない）。quiz本文・トークン等の機微情報は記録しない
 * （計画linear-zooming-conway.md「PR B」節参照）。
 *
 * 書き込み失敗はここで握りつぶしログのみ — 監査ログの障害がツール呼び出し
 * 自体の失敗理由になってはならない。
 */
const COLLECTION = "mcp_audit_logs";
const DEFAULT_TIMEOUT_MS = 3000;

export interface AuditLogEntry {
  actor: string;
  tenant: string;
  tool: string;
  targetId?: string;
  correlationId?: string;
  result: "success" | "error";
}

export interface AuditLogOptions {
  /** 既定3000ms。Firestore劣化時にツール呼び出し自体が無期限にブロックされないための上限（codex review指摘） */
  timeoutMs?: number;
}

export interface AuditLog {
  record(entry: AuditLogEntry): Promise<void>;
}

export function createAuditLog(db: Firestore, options: AuditLogOptions = {}): AuditLog {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async record(entry: AuditLogEntry): Promise<void> {
      const writePromise = (async () => {
        try {
          await db
            .collection(COLLECTION)
            .doc(randomUUID())
            .set({
              actor: entry.actor,
              tenant: entry.tenant,
              tool: entry.tool,
              result: entry.result,
              ...(entry.targetId !== undefined && { targetId: entry.targetId }),
              ...(entry.correlationId !== undefined && { correlationId: entry.correlationId }),
              createdAt: new Date(),
            });
        } catch (error) {
          logger.error("Failed to write mcp_audit_logs entry", { actor: entry.actor, tool: entry.tool, error: String(error) });
        }
      })();

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          logger.error("Writing mcp_audit_logs entry exceeded timeout; continuing without waiting", {
            actor: entry.actor,
            tool: entry.tool,
            timeoutMs,
          });
          resolve();
        }, timeoutMs);
        timeoutHandle.unref();
      });

      await Promise.race([writePromise, timeoutPromise]);
      // writePromise が先に解決した場合、タイマーを止めないと timeoutMs 後に
      // 「タイムアウトした」という偽のログが遅延発火する（PR A router.tsで
      // 発生・修正済みの既知の落とし穴、同型のバグを再導入しないよう対応）。
      clearTimeout(timeoutHandle);
    },
  };
}
