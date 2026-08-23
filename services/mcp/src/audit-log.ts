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

export interface AuditLogEntry {
  actor: string;
  tenant: string;
  tool: string;
  targetId?: string;
  correlationId?: string;
  result: "success" | "error";
}

export interface AuditLog {
  record(entry: AuditLogEntry): Promise<void>;
}

export function createAuditLog(db: Firestore): AuditLog {
  return {
    async record(entry: AuditLogEntry): Promise<void> {
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
    },
  };
}
