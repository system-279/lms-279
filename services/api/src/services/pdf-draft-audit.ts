/**
 * Phase 2: Gmail 下書き作成の監査ログ書き込み。
 *
 * ADR-034 §7 スキーマに準拠:
 *   tenants/{tenantId}/pdf_draft_logs/{requestId}
 *
 * PII 最小化:
 *   - createdByEmail / ownerEmail は sha256 ハッシュで保存
 *   - PDF 内容は保存しない (size のみ)
 *
 * TTL 90 日 (Firestore TTL policy で `ttlAt` フィールドを使用)
 */

import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import type { ProgressPdfSections } from "@lms-279/shared-types";
import { logger } from "../utils/logger.js";

const TTL_DAYS = 90;

export interface PdfDraftAuditLog {
  requestId: string;
  tenantId: string;
  createdByUid: string;
  createdByEmail: string;
  userId: string;
  /**
   * 受講者本人 email (To 宛先)。case B 採用後の新規宛先。
   * 失敗時 (PDF 生成前のバリデーションエラー等) で未確定なら null を許容。
   */
  toEmail: string | null;
  /** テナント管理者 email (旧 To / 新 CC)。未設定なら null。 */
  ownerEmail: string | null;
  draftId: string | null;
  status: "success" | "failed";
  errorCode: string | null;
  sections: ProgressPdfSections;
  pdfSizeBytes: number | null;
}

/** メールアドレスを sha256 でハッシュ化 (PII 最小化) */
export function hashEmail(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase(), "utf-8")
    .digest("hex");
}

/**
 * Firestore に PDF 下書き作成ログを書き込む。
 *
 * Firestore 書き込み失敗は logger.error で記録し throw する
 * (呼び出し側でレスポンスへの影響を判断する)。
 */
export async function recordPdfDraftLog(
  db: Firestore,
  log: PdfDraftAuditLog,
): Promise<void> {
  const now = new Date();
  const ttlAt = Timestamp.fromMillis(now.getTime() + TTL_DAYS * 86400 * 1000);

  // Dual-write 戦略 (ADR-034 §7):
  // - 旧 `ownerEmailHash`: 後方互換のため残置。読み手 (運用 query / 旧分析) が両方を読める間は維持。
  // - 新 `recipientToHash`: To 宛先 (受講者本人) のハッシュ。
  // - 新 `recipientCcHash`: CC 宛先 (テナント管理者) のハッシュ。CC 省略時は null。
  // 旧スキーマのみのドキュメントとの idempotency 互換は route 層で `status + draftId`
  // のみで判定するため、本フィールドの有無は idempotency 取得に影響しない。
  const ccHash = log.ownerEmail ? hashEmail(log.ownerEmail) : null;
  const document = {
    createdAt: now.toISOString(),
    createdByUid: log.createdByUid,
    createdByEmailHash: hashEmail(log.createdByEmail),
    userId: log.userId,
    // 旧 (deprecated) と新は移行期間中は同値
    ownerEmailHash: ccHash,
    recipientCcHash: ccHash,
    recipientToHash: log.toEmail ? hashEmail(log.toEmail) : null,
    draftId: log.draftId,
    status: log.status,
    errorCode: log.errorCode,
    sections: log.sections,
    pdfSizeBytes: log.pdfSizeBytes,
    ttlAt,
  };

  try {
    await db
      .collection("tenants")
      .doc(log.tenantId)
      .collection("pdf_draft_logs")
      .doc(log.requestId)
      .set(document);
  } catch (err) {
    logger.error("Failed to write pdf_draft_logs", {
      errorType: "pdf_draft_audit_write_failed",
      error: err instanceof Error ? err : new Error(String(err)),
      tenantId: log.tenantId,
      requestId: log.requestId,
      status: log.status,
    });
    throw err;
  }
}

export const __internal = { TTL_DAYS };
