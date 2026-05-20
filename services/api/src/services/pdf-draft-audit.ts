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
  /**
   * Issue #436: access token の発行元 Google アカウント email。
   * - 一致 / 不一致 / 取得不能のいずれでも、tokeninfo で取得できた値があれば記録する。
   * - tokeninfo 失敗時 (取得不能) は null。
   * - 監査追跡のためであり、書き込み時点で createdByEmail との一致は保証しない
   *   (一致しなければ route 層が 403 を返し、本ログは status=failed で書き込まれる)。
   * - 後方互換のため optional。未指定なら null として扱う。
   */
  tokenOwnerEmail?: string | null;
  draftId: string | null;
  status: "success" | "failed";
  errorCode: string | null;
  sections: ProgressPdfSections;
  pdfSizeBytes: number | null;
}

/**
 * Issue #435: acquirePendingPdfDraftLog 用の pending 段階ログ。
 *
 * Gmail draft 作成前の認可境界フィールドのみを記録する。
 * - draftId / status / errorCode / pdfSizeBytes は確定後 (finalizePdfDraftLog) に追記。
 *
 * 並行リクエスト防止のため、Firestore `create()` (precondition: not exists) で書き込む。
 */
export interface PendingPdfDraftLogInput {
  requestId: string;
  tenantId: string;
  createdByUid: string;
  createdByEmail: string;
  userId: string;
  toEmail: string;
  ownerEmail: string | null;
  tokenOwnerEmail: string;
  sections: ProgressPdfSections;
}

export type AcquirePendingResult =
  | { acquired: true }
  | {
      acquired: false;
      /** 既存 doc の中身 (Firestore raw data)。route 層で status を見て分岐する。 */
      existing: FirebaseFirestore.DocumentData;
    };

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
    // Issue #436: access token の発行元 Google アカウント email を sha256 で記録。
    // tokeninfo 失敗時 / 未指定は null。
    tokenOwnerHash: log.tokenOwnerEmail ? hashEmail(log.tokenOwnerEmail) : null,
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

/**
 * Issue #435 (AC-1 / AC-5): pending 段階のログを Firestore に **アトミックに** 先取りする。
 *
 * 並行 2 リクエストが同じ requestId で Gmail draft を二重作成するのを防ぐ。
 * `create()` (precondition: not exists) を使い、ALREADY_EXISTS なら既存 doc を返す。
 *
 * @returns
 *   - `{ acquired: true }`: pending 取得成功、Gmail API を呼び出してよい
 *   - `{ acquired: false, existing }`: 既存 doc あり (status を見て分岐: success → 200 / pending → 409 / failed → 再試行)
 * @throws Firestore の (ALREADY_EXISTS 以外の) 障害は throw。route 層は 503 で返す。
 */
export async function acquirePendingPdfDraftLog(
  db: Firestore,
  input: PendingPdfDraftLogInput,
): Promise<AcquirePendingResult> {
  const now = new Date();
  const ttlAt = Timestamp.fromMillis(now.getTime() + TTL_DAYS * 86400 * 1000);

  const ccHash = input.ownerEmail ? hashEmail(input.ownerEmail) : null;
  const document = {
    createdAt: now.toISOString(),
    createdByUid: input.createdByUid,
    createdByEmailHash: hashEmail(input.createdByEmail),
    userId: input.userId,
    ownerEmailHash: ccHash,
    recipientCcHash: ccHash,
    recipientToHash: hashEmail(input.toEmail),
    tokenOwnerHash: hashEmail(input.tokenOwnerEmail),
    draftId: null,
    status: "pending" as const,
    errorCode: null,
    sections: input.sections,
    pdfSizeBytes: null,
    ttlAt,
  };

  const docRef = db
    .collection("tenants")
    .doc(input.tenantId)
    .collection("pdf_draft_logs")
    .doc(input.requestId);

  try {
    await docRef.create(document);
    return { acquired: true };
  } catch (err) {
    // ALREADY_EXISTS (gRPC code 6) → 既存 doc を取得して呼び出し側に返す
    const code = (err as { code?: number | string })?.code;
    if (code === 6 || code === "6" || code === "ALREADY_EXISTS") {
      try {
        const snapshot = await docRef.get();
        if (snapshot.exists) {
          return { acquired: false, existing: snapshot.data() ?? {} };
        }
      } catch (getErr) {
        logger.error("Failed to read existing pdf_draft_logs after ALREADY_EXISTS", {
          errorType: "pdf_draft_audit_read_after_create_conflict_failed",
          error: getErr instanceof Error ? getErr : new Error(String(getErr)),
          tenantId: input.tenantId,
          requestId: input.requestId,
        });
        throw getErr;
      }
      // create が ALREADY_EXISTS なのに get で exists=false (TOCTOU 競合の極端ケース) → throw
      logger.error("pdf_draft_logs ALREADY_EXISTS but doc not found on subsequent read", {
        tenantId: input.tenantId,
        requestId: input.requestId,
      });
      throw err;
    }
    logger.error("Failed to acquire pending pdf_draft_logs", {
      errorType: "pdf_draft_audit_acquire_pending_failed",
      error: err instanceof Error ? err : new Error(String(err)),
      tenantId: input.tenantId,
      requestId: input.requestId,
    });
    throw err;
  }
}

/**
 * Issue #435 (AC-5): pending → success/failed の状態遷移を記録する。
 *
 * `acquirePendingPdfDraftLog` で先取りしたドキュメントに `draftId` / `status` /
 * `errorCode` / `pdfSizeBytes` を追記する。`set({ merge: true })` で他フィールドを保持。
 *
 * 既存の `recordPdfDraftLog` と異なり、pending 取得済みドキュメントへの追記専用。
 * 監査ログ書き込み失敗は throw する (呼び出し側でレスポンスへの影響を判断)。
 */
export async function finalizePdfDraftLog(
  db: Firestore,
  params: {
    requestId: string;
    tenantId: string;
    draftId: string | null;
    status: "success" | "failed";
    errorCode: string | null;
    pdfSizeBytes: number | null;
  },
): Promise<void> {
  const docRef = db
    .collection("tenants")
    .doc(params.tenantId)
    .collection("pdf_draft_logs")
    .doc(params.requestId);

  try {
    await docRef.set(
      {
        draftId: params.draftId,
        status: params.status,
        errorCode: params.errorCode,
        pdfSizeBytes: params.pdfSizeBytes,
        // 状態遷移時刻 (運用追跡用)
        finalizedAt: new Date().toISOString(),
      },
      { merge: true },
    );
  } catch (err) {
    logger.error("Failed to finalize pdf_draft_logs", {
      errorType: "pdf_draft_audit_finalize_failed",
      error: err instanceof Error ? err : new Error(String(err)),
      tenantId: params.tenantId,
      requestId: params.requestId,
      status: params.status,
    });
    throw err;
  }
}

export const __internal = { TTL_DAYS };
