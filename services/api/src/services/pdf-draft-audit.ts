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
 * Issue #435: acquirePendingPdfDraftLog 用の pending 段階ログ + 認可境界フィールド。
 *
 * Gmail draft 作成前の認可境界フィールド (createdByUid + userId + tokenOwnerEmail) を含む。
 * - draftId / status / errorCode / pdfSizeBytes は確定後 (finalizePdfDraftLog) に追記。
 *
 * 並行リクエスト防止のため、Firestore `runTransaction` で読み + 書きをアトミックに行う。
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

/**
 * Issue #435 + Codex review: acquire 結果の判別共用体。
 * - `acquired`: pending 取得成功 (新規 / failed 上書き) → Gmail API を呼び出してよい
 * - `in_flight`: 既存 pending あり → 409 invalid_request_id (並行リクエスト中)
 * - `existing_success`: 既存 success かつ 認可境界 (createdByUid + userId) 一致 → 200 既存 draftId
 * - `collision`: 既存 success かつ 認可境界 不一致 → 409 invalid_request_id (別 actor / 別 user)
 */
export type AcquirePendingResult =
  | { kind: "acquired" }
  | { kind: "in_flight"; existing: FirebaseFirestore.DocumentData }
  | { kind: "existing_success"; draftId: string }
  | { kind: "collision"; existing: FirebaseFirestore.DocumentData };

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
 * Issue #435 (AC-1 / AC-5) + Codex review High 1-3: pending 段階のログを
 * Firestore `runTransaction` でアトミックに取得 + 認可境界判定する。
 *
 * 1 つの transaction 内で読み + 書き + 状態判定を行うため、並行リクエストの race condition と
 * recordPdfDraftLog (early-failure set) との merge 不整合の両方を防ぐ。
 *
 * 状態遷移仕様:
 * - doc 不存在 → tx.create(pending) → `acquired`
 * - 既存 `status: "pending"` → 並行中、上書きせず `in_flight` を返す (route で 409)
 * - 既存 `status: "success"`:
 *   - `createdByUid` + `userId` 一致 (旧スキーマ欠落は許容) → `existing_success` (route で 200)
 *   - 不一致 → `collision` (route で 409)
 * - 既存 `status: "failed"` → tx.set(pending) で上書き再試行 → `acquired`
 *
 * @throws Firestore 障害は throw。route 層は 503 で返す。
 */
export async function acquirePendingPdfDraftLog(
  db: Firestore,
  input: PendingPdfDraftLogInput,
): Promise<AcquirePendingResult> {
  const now = new Date();
  const ttlAt = Timestamp.fromMillis(now.getTime() + TTL_DAYS * 86400 * 1000);

  const ccHash = input.ownerEmail ? hashEmail(input.ownerEmail) : null;
  const pendingDocument = {
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
    return await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(docRef);
      if (!snapshot.exists) {
        tx.create(docRef, pendingDocument);
        return { kind: "acquired" } satisfies AcquirePendingResult;
      }
      const data = snapshot.data() ?? {};
      const existingStatus = data.status;

      if (existingStatus === "pending") {
        return { kind: "in_flight", existing: data } satisfies AcquirePendingResult;
      }

      if (existingStatus === "success" && typeof data.draftId === "string") {
        // 認可境界 (PR #449 と同等): 別 actor / 別 user の既存 draft を横取りできないよう照合
        // 旧スキーマで createdByUid / userId 不在ならスキップして後方互換維持
        const ownerMatches =
          typeof data.createdByUid !== "string" || data.createdByUid === input.createdByUid;
        const userMatches = typeof data.userId !== "string" || data.userId === input.userId;
        if (ownerMatches && userMatches) {
          return { kind: "existing_success", draftId: data.draftId } satisfies AcquirePendingResult;
        }
        return { kind: "collision", existing: data } satisfies AcquirePendingResult;
      }

      // existing_status === "failed" (または想定外 status) → pending に上書き再試行
      // Codex review High 95 対応: failed doc を create() で上書きできない問題を transaction の set() で解決
      tx.set(docRef, pendingDocument);
      return { kind: "acquired" } satisfies AcquirePendingResult;
    });
  } catch (err) {
    logger.error("Failed to acquire pending pdf_draft_logs (transaction failed)", {
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
