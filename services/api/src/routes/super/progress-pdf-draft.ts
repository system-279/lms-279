/**
 * スーパー管理者向け 受講者進捗 PDF Gmail 下書き作成ルート (Phase 2)。
 *
 * POST /api/v2/super/tenants/:tenantId/users/:userId/progress-pdf-draft
 *   body: { requestId: string, sections: ProgressPdfSections, accessToken: string }
 *   201:  { draftId, draftUrl }
 *   400:  bad_request / invalid_sections / invalid_request_id / invalid_access_token
 *         / demo_tenant_not_supported / invalid_tenant_id / invalid_user_id
 *         / no_sections_selected / user_email_not_configured / invalid_owner_email
 *   401:  invalid_access_token (Gmail API token 期限切れ)
 *   403:  gmail_scope_required (gmail.compose scope 不足)
 *   404:  tenant_not_found / user_not_in_tenant
 *   413:  pdf_too_large_for_gmail
 *   429:  gmail_quota_exceeded
 *   500:  pdf_generation_failed
 *   502:  gmail_api_error
 *   503:  gmail_api_transient
 *
 * 認可は親ルータ super-admin.ts の superAdminAuthMiddleware に依存（全 super 配下に適用済）。
 *
 * ADR-034 に準拠。Phase 1 (progress-pdf.ts) と同じ越境チェック・パストラバーサル防止・
 * PDF 生成ロジックを再利用し、追加で Gmail draft 作成・監査ログ書き込みを行う。
 *
 * 宛先ロジック (ADR-034 §5): To=受講者本人 (users/{userId}.email) / CC=テナント管理者 (ownerEmail)
 * - ownerEmail 未設定 → CC 省略で送信成功 (旧 owner_email_not_set 経路は廃止)
 * - ownerEmail CRLF/カンマ/制御文字 → 400 invalid_owner_email
 * - user.email 未設定/空白/不正 → 400 user_email_not_configured
 */

import { Router, type Request, type Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { renderToBuffer } from "@react-pdf/renderer";
import {
  buildProgressPdfFilename,
  type ProgressPdfDraftErrorCode,
  type ProgressPdfDraftRequest,
  type ProgressPdfDraftResponse,
  type ProgressPdfSectionKey,
  type ProgressPdfSections,
} from "@lms-279/shared-types";
import { getDataSource } from "../../datasource/factory.js";
import { validateTenantId } from "../../middleware/tenant.js";
import { buildProgressPdfData, type TenantInfo } from "../../services/progress-pdf.js";
import { ProgressPdfDocument } from "../../services/progress-pdf-document.js";
import { buildMailTemplate } from "../../services/progress-pdf-mail-template.js";
import {
  buildGmailDraftUrl,
  createGmailDraft,
  GmailDraftError,
  verifyAccessTokenOwner,
  type MimeAttachment,
} from "../../services/gmail-draft.js";
import {
  acquirePendingPdfDraftLog,
  finalizePdfDraftLog,
  hashEmail,
  recordPdfDraftLog,
} from "../../services/pdf-draft-audit.js";
import { logger } from "../../utils/logger.js";
import { classifyFirestoreError, TRANSIENT_RETRY_MESSAGE_JA } from "../../utils/grpc-errors.js";

const PDF_MAX_BYTES = 5 * 1024 * 1024; // 5MB (Phase 1 と整合)
const USER_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
// Evaluator MEDIUM 対応: Firestore ドキュメント ID として安全な文字のみ許可
// (`/` を含むと sub-collection と誤解釈される)
const REQUEST_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const SECTION_KEYS: ProgressPdfSectionKey[] = [
  "profile",
  "deadline",
  "summary",
  "lessons",
  "quiz",
  "pace",
  "video",
];

/**
 * 受講者 / テナント管理者の email を Gmail 宛先として使う前のバリデーション。
 * Gmail API 投入前の defense-in-depth として、CRLF / カンマ / 制御文字 / 形式違反を拒否する。
 *
 * @returns 正規化済 (trim 後) の email、またはエラー理由 (logger 用途のみ、外部レスポンスには出さない)
 */
type EmailValidation =
  | { ok: true; value: string }
  | { ok: false; reason: "empty" | "crlf" | "comma" | "control" | "format" };

function validateRecipientEmail(input: unknown): EmailValidation {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  // CRLF チェックは trim 後だが、前後の `\r` / `\n` 単独パターンは trim で除去される。
  // それらは MIME ヘッダ注入のリスクではないため除去後の値で問題ない。
  // 内部に挟まる `\r` / `\n` は trim で消えないためここで捕捉する。
  if (/[\r\n]/.test(trimmed)) return { ok: false, reason: "crlf" };
  // 複数宛先 (カンマ区切り) を許すと「受講者本人単体宛」の前提が崩れる
  if (/,/.test(trimmed)) return { ok: false, reason: "comma" };
  // CRLF 以外の C0/DEL 制御文字も拒否 (CRLF は上で捕捉済)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return { ok: false, reason: "control" };
  // RFC 5321 完全準拠は Gmail 側の責務。ここは最小限の形式チェックのみ。
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(trimmed)) return { ok: false, reason: "format" };
  return { ok: true, value: trimmed };
}

const router = Router();

function parseSections(input: unknown): ProgressPdfSections | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const result = {} as ProgressPdfSections;
  for (const key of SECTION_KEYS) {
    if (typeof obj[key] !== "boolean") return null;
    result[key] = obj[key] as boolean;
  }
  return result;
}

type ParsedBody = ProgressPdfDraftRequest;
type ParseError = { error: ProgressPdfDraftErrorCode; message: string };

function parseBody(body: unknown): ParsedBody | ParseError {
  if (!body || typeof body !== "object") {
    return { error: "bad_request", message: "Request body is required" };
  }
  const obj = body as Record<string, unknown>;
  const { requestId, sections, accessToken } = obj;

  if (typeof requestId !== "string" || !REQUEST_ID_REGEX.test(requestId)) {
    return {
      error: "invalid_request_id",
      message: "requestId must be 1-128 chars of [A-Za-z0-9._-] (no slashes or other unsafe chars)",
    };
  }
  const parsedSections = parseSections(sections);
  if (!parsedSections) {
    return {
      error: "invalid_sections",
      message: `sections must include 7 boolean flags: ${SECTION_KEYS.join(", ")}`,
    };
  }
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return { error: "invalid_access_token", message: "accessToken must be a non-empty string" };
  }
  return { requestId, sections: parsedSections, accessToken };
}

router.post(
  "/tenants/:tenantId/users/:userId/progress-pdf-draft",
  async (req: Request, res: Response) => {
    const rawTenantId = req.params.tenantId as string;
    const rawUserId = req.params.userId as string;

    // パストラバーサル防止 (Phase 1 と同じ)
    const tenantId = validateTenantId(rawTenantId);
    if (!tenantId) {
      res.status(400).json({
        error: "invalid_tenant_id",
        message: "Invalid tenant ID. Must be 1-64 alphanumeric characters, hyphens, or underscores.",
      });
      return;
    }
    // demo テナント拒否 (Phase 1 と整合: 共有 InMemoryDataSource では越境チェックが効かない)
    if (tenantId === "demo") {
      res.status(400).json({
        error: "demo_tenant_not_supported",
        message: "Demo tenant is not supported for progress PDF draft creation",
      });
      return;
    }
    if (!USER_ID_REGEX.test(rawUserId)) {
      res.status(400).json({
        error: "invalid_user_id",
        message: "Invalid user ID. Must be 1-128 alphanumeric characters, hyphens, or underscores.",
      });
      return;
    }
    const userId = rawUserId;

    const parsed = parseBody(req.body);
    if ("error" in parsed) {
      res.status(400).json(parsed);
      return;
    }

    // AC-10: 全 section が false なら 400 (Phase 1 と異なり Phase 2 では強制)
    const anySectionEnabled = SECTION_KEYS.some((k) => parsed.sections[k]);
    if (!anySectionEnabled) {
      res.status(400).json({
        error: "no_sections_selected",
        message: "At least one section must be selected for draft creation",
      });
      return;
    }

    // super-admin auth middleware で req.superAdmin がセットされている前提
    const superAdmin = req.superAdmin;
    if (!superAdmin) {
      // middleware が通っていない異常系
      res.status(401).json({
        error: "unauthorized",
        message: "Super admin auth context is missing",
      });
      return;
    }
    const createdByEmail = superAdmin.email;
    const createdByUid = superAdmin.firebaseUid ?? `dev_${createdByEmail}`;

    // Evaluator HIGH-2/MEDIUM 対応: db は 1 回だけ取得して使い回す
    const db = getFirestore();

    // Issue #435 + Codex review High 1/2/3: 旧の手動 idempotency check
    // (`docRef.get()` → status 判定 → 認可境界チェック) は撤去。すべての判定を
    // `acquirePendingPdfDraftLog` の Firestore transaction 内に集約することで、
    //   - 別 actor / 別 user の success ログを横取りする race 経路 (Codex High 1)
    //   - `recordPdfDraftLog().set()` との書き込みモデル混在 (Codex High 90)
    //   - failed 既存 doc の上書き再試行不可 (Codex High 95)
    // を解消する。
    //
    // acquire は token verify 成功後 (PDF 生成も完了後) に呼び出す。pending を取得した時点で
    // Gmail draft 作成へ進み、その成功/失敗を finalize で記録する。
    //
    // AC-3 (idempotency check 失敗 → 503): acquire transaction 内で throw された場合に対応する
    // catch ブロックで 503 を返す (route 下方の acquire try/catch を参照)。

    // Issue #436: access token の発行元 Google アカウント email を取得し、
    // Firebase Auth (superAdmin.email) と一致するか検証する。
    // - 一致 → 続行
    // - 不一致 → 403 access_token_owner_mismatch + 失敗監査ログ + Gmail API 呼ばない
    // - tokeninfo 失敗 (transient/401 等) → 該当 httpStatus + 失敗監査ログ + Gmail API 呼ばない
    // 監査用に取得した owner email は tokenOwnerEmail として後続の recordPdfDraftLog に渡す。
    let tokenOwnerEmail: string | null = null;
    try {
      const ownerResult = await verifyAccessTokenOwner(parsed.accessToken);
      tokenOwnerEmail = ownerResult.email;
      // Codex review (Issue #436): Google が email 所有を確認していない (verified_email !== true)
      // token を受理すると、Google アカウント乗っ取り経路の所有性偽装を見逃す。
      // 通常 OAuth では verified_email は true、false の場合は防御強化として 401 で拒否する。
      if (!ownerResult.verified) {
        logger.warn("Access token owner email is not verified by Google", {
          tenantId,
          userId,
          requestId: parsed.requestId,
          tokenOwnerHash: hashEmail(tokenOwnerEmail),
        });
        await recordPdfDraftLog(db, {
          requestId: parsed.requestId,
          tenantId,
          createdByUid,
          createdByEmail,
          userId,
          toEmail: null,
          ownerEmail: null,
          tokenOwnerEmail,
          draftId: null,
          status: "failed",
          errorCode: "invalid_access_token",
          sections: parsed.sections,
          pdfSizeBytes: null,
        }).catch((auditErr: unknown) => {
          logger.warn("Failed to record unverified-email audit log", {
            errorType: "pdf_draft_audit_write_failed_unverified",
            tenantId,
            requestId: parsed.requestId,
            errorMessage: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        });
        res.status(401).json({
          error: "invalid_access_token",
          message: "Access token owner email is not verified by Google",
        });
        return;
      }
      const expected = createdByEmail.trim().toLowerCase();
      if (tokenOwnerEmail !== expected) {
        // 不一致: Gmail API 呼ばずに 403 を返す + 失敗監査ログ
        logger.warn("Access token owner does not match super admin email", {
          tenantId,
          userId,
          requestId: parsed.requestId,
          // PII を出さないため hash で記録
          tokenOwnerHash: hashEmail(tokenOwnerEmail),
          expectedHash: hashEmail(expected),
        });
        await recordPdfDraftLog(db, {
          requestId: parsed.requestId,
          tenantId,
          createdByUid,
          createdByEmail,
          userId,
          toEmail: null,
          ownerEmail: null,
          tokenOwnerEmail,
          draftId: null,
          status: "failed",
          errorCode: "access_token_owner_mismatch",
          sections: parsed.sections,
          pdfSizeBytes: null,
        }).catch((auditErr: unknown) => {
          logger.warn("Failed to record access_token_owner_mismatch audit log", {
            errorType: "pdf_draft_audit_write_failed_403_owner_mismatch",
            tenantId,
            requestId: parsed.requestId,
            errorMessage: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        });
        res.status(403).json({
          error: "access_token_owner_mismatch",
          message:
            "Access token owner does not match authenticated super admin email",
        });
        return;
      }
    } catch (err) {
      const gmailErr = err instanceof GmailDraftError ? err : null;
      const errorCode: ProgressPdfDraftErrorCode = gmailErr?.errorCode ?? "gmail_api_error";
      const httpStatus = gmailErr?.httpStatus ?? 502;
      // Issue #437 (PII フィルタ): logger に raw Gmail API error message を出さない。
      // errorCode + httpStatus のみで運用追跡し、内容の詳細は GCP Logs Explorer で
      // Cloud Run の stderr (req/res の telemetry) を別途参照する。
      logger.warn("Failed to verify access token owner (Gmail API call skipped)", {
        tenantId,
        userId,
        requestId: parsed.requestId,
        errorCode,
        httpStatus,
      });
      await recordPdfDraftLog(db, {
        requestId: parsed.requestId,
        tenantId,
        createdByUid,
        createdByEmail,
        userId,
        toEmail: null,
        ownerEmail: null,
        tokenOwnerEmail: null,
        draftId: null,
        status: "failed",
        errorCode,
        sections: parsed.sections,
        pdfSizeBytes: null,
      }).catch((auditErr: unknown) => {
        logger.warn("Failed to record tokeninfo failure audit log", {
          errorType: "pdf_draft_audit_write_failed_tokeninfo",
          tenantId,
          requestId: parsed.requestId,
          primaryErrorCode: errorCode,
          primaryHttpStatus: httpStatus,
          errorMessage: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      });
      // Issue #437: 外部レスポンスには publicMessage (固定文言) のみ返す
      res.status(httpStatus).json({
        error: errorCode,
        message: gmailErr?.publicMessage ?? "Failed to verify access token",
      });
      return;
    }

    // tenant doc + DataSource 取得 (Phase 1 と同じ)
    let tenant: TenantInfo;
    // PdfDraftAuditLog.toEmail (string | null) と整合させる。catch 経路で未代入のまま
    // 監査ログを呼ぶ可能性に備えた null 初期化 (Gmail 呼び出しに進む前に検証で代入される)。
    let validatedToEmail: string | null = null;
    let validatedCcEmail: string | null;
    let pdfBuffer: Buffer;
    let subject: string;
    let body: string;
    let attachment: MimeAttachment;
    let attachmentBytes: number;

    try {
      const tenantDoc = await db.collection("tenants").doc(tenantId).get();
      if (!tenantDoc.exists) {
        res.status(404).json({ error: "tenant_not_found", message: "Tenant not found" });
        return;
      }
      const tenantData = tenantDoc.data() ?? {};
      tenant = {
        id: tenantId,
        name: typeof tenantData.name === "string" ? tenantData.name : tenantId,
        ownerEmail:
          typeof tenantData.ownerEmail === "string" && tenantData.ownerEmail.length > 0
            ? tenantData.ownerEmail
            : null,
      };

      // ownerEmail バリデーション:
      // - null / 空文字 / 全空白 → CC 省略 (送信成功、後方互換)
      // - CRLF / カンマ / 制御文字 / 形式違反 → 400 invalid_owner_email
      // validateRecipientEmail は null/空文字も `reason: "empty"` で扱うため null チェックを吸収できる。
      const ownerCheck = validateRecipientEmail(tenant.ownerEmail);
      if (ownerCheck.ok) {
        validatedCcEmail = ownerCheck.value;
      } else if (ownerCheck.reason === "empty") {
        validatedCcEmail = null;
      } else {
        logger.warn("Invalid tenant ownerEmail rejected for Gmail draft", {
          tenantId,
          requestId: parsed.requestId,
          reason: ownerCheck.reason,
        });
        res.status(400).json({
          error: "invalid_owner_email",
          message: "Tenant ownerEmail is invalid",
        });
        return;
      }

      // tenant scope の DataSource を取得（demo は上で弾いているので isDemo は常に false）
      const dataSource = getDataSource({ tenantId, isDemo: false });

      // Phase 1 と同じデータ集約
      const pdfData = await buildProgressPdfData({
        dataSource,
        tenant,
        userId,
      });

      // 受講者本人 email バリデーション (新規 To 宛先):
      // student-progress 経路で空文字に落ちる可能性があるため、
      // BE/FE/監査ログでズレが起きないよう trim + 多角的バリデーションを行う。
      const userEmailCheck = validateRecipientEmail(pdfData.user.email);
      if (!userEmailCheck.ok) {
        logger.warn("Invalid student email rejected for Gmail draft", {
          tenantId,
          userId,
          requestId: parsed.requestId,
          reason: userEmailCheck.reason,
        });
        res.status(400).json({
          error: "user_email_not_configured",
          message: "Student email is missing or invalid",
        });
        return;
      }
      validatedToEmail = userEmailCheck.value;

      // PDF 生成 (Phase 1 ロジック再利用)
      pdfBuffer = await renderToBuffer(
        ProgressPdfDocument({ data: pdfData, sections: parsed.sections }),
      );

      if (pdfBuffer.length > PDF_MAX_BYTES) {
        logger.warn("Progress PDF size exceeded limit for Gmail draft", {
          tenantId,
          userId,
          sizeBytes: pdfBuffer.length,
          limitBytes: PDF_MAX_BYTES,
          requestId: parsed.requestId,
        });
        // 失敗監査ログを書き込んでから返す
        await recordPdfDraftLog(db, {
          requestId: parsed.requestId,
          tenantId,
          createdByUid,
          createdByEmail,
          userId,
          toEmail: validatedToEmail,
          ownerEmail: validatedCcEmail,
          tokenOwnerEmail,
          draftId: null,
          status: "failed",
          errorCode: "pdf_too_large_for_gmail",
          sections: parsed.sections,
          pdfSizeBytes: pdfBuffer.length,
        }).catch((auditErr: unknown) => {
          // 監査ログ失敗はレスポンスをブロックしないが、サイレント化せず警告ログを残す
          // (Firestore 障害時に「PDF サイズ超過」のシグナルが完全に消えるのを防ぐ)
          logger.warn("Failed to record pdf_too_large_for_gmail audit log", {
            errorType: "pdf_draft_audit_write_failed_413",
            tenantId,
            requestId: parsed.requestId,
            pdfSizeBytes: pdfBuffer.length,
            errorMessage: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        });
        res.status(413).json({
          error: "pdf_too_large_for_gmail",
          message: `Generated PDF exceeds ${PDF_MAX_BYTES} bytes`,
        });
        return;
      }

      attachmentBytes = pdfBuffer.length;
      const template = buildMailTemplate({
        data: pdfData,
        senderName: createdByEmail, // displayName は dev では取得不可なので email を使用
        // ownerEmail 設定済のときだけ本文に CC 注記を追加 (未設定時の虚偽記載防止)
        ccEmail: validatedCcEmail ?? undefined,
      });
      subject = template.subject;
      body = template.body;

      const dateStr = pdfData.generatedAt.slice(0, 10);
      // Gmail UI 表示用に日本語の受講者名をそのまま filename に含める。
      // MIME ヘッダの dual-form (filename + filename*=) は gmail-draft.ts が生成する。
      attachment = {
        filename: buildProgressPdfFilename({
          name: pdfData.user.name,
          email: pdfData.user.email,
          date: dateStr,
        }),
        contentType: "application/pdf",
        content: pdfBuffer,
      };
    } catch (err) {
      if (err instanceof Error && err.message === "user_not_in_tenant") {
        res.status(404).json({
          error: "user_not_in_tenant",
          message: "User not found in the specified tenant",
        });
        return;
      }
      const { grpcCode, isTransient } = classifyFirestoreError(err);
      logger.error("Failed to prepare progress PDF for Gmail draft", {
        errorType: "progress_pdf_draft_prep_failed",
        error: err instanceof Error ? err : new Error(String(err)),
        tenantId,
        userId,
        grpcCode,
        isTransient,
      });
      res.status(isTransient ? 503 : 500).json({
        error: "pdf_generation_failed",
        message: isTransient ? TRANSIENT_RETRY_MESSAGE_JA : "PDF 生成に失敗しました",
      });
      return;
    }

    // Issue #435 (AC-1 / AC-5): Gmail draft 作成の直前に pending ログを **アトミックに** 先取りする。
    // `acquirePendingPdfDraftLog` は Firestore transaction で以下を行う:
    //   - doc 不存在 → tx.create(pending) で先取り → acquired=true
    //   - 既存 status=pending → in_flight (並行 2 件目)
    //   - 既存 status=success → already_success (PR #449 で弾かれているはずだが防御層)
    //   - 既存 status=failed → tx.set(pending) で上書きして再試行を許容 → acquired=true
    // この時点で tokenOwnerEmail は確定済 (Issue #436 検証成功)、validatedToEmail も確定済。
    //
    // AC-3: Firestore 障害は throw → 503 で停止 (Gmail API 呼ばない)。
    if (!tokenOwnerEmail) {
      // 型ガード: ここまで来たら token owner 検証で必ず設定されているが、防御
      logger.error("Internal invariant: tokenOwnerEmail is null after verifyAccessTokenOwner", {
        tenantId,
        requestId: parsed.requestId,
      });
      res.status(500).json({
        error: "pdf_generation_failed",
        message: "Internal state error",
      });
      return;
    }

    // Codex review High 1/3: acquire transaction で
    //   - success 既存の認可境界 (createdByUid + userId) チェック
    //   - failed 既存の上書き再試行 (旧 docRef.create() では不可だった)
    // を一括処理する。
    let pendingAcquired = false;
    try {
      const acquireResult = await acquirePendingPdfDraftLog(db, {
        requestId: parsed.requestId,
        tenantId,
        createdByUid,
        createdByEmail,
        userId,
        toEmail: validatedToEmail,
        ownerEmail: validatedCcEmail,
        tokenOwnerEmail,
        sections: parsed.sections,
      });
      switch (acquireResult.kind) {
        case "acquired":
          pendingAcquired = true;
          break;
        case "in_flight":
          // 並行リクエストが先に pending を取った → 409 in_flight
          logger.warn("Concurrent pdf draft request — pending already in flight", {
            tenantId,
            requestId: parsed.requestId,
          });
          res.status(409).json({
            error: "invalid_request_id",
            message: "A draft for this requestId is already in flight",
          });
          return;
        case "existing_success": {
          // 既存 success doc + 認可境界一致 → 200 既存 draftId
          const existingDraftId = acquireResult.draftId;
          res.status(200).json({
            draftId: existingDraftId,
            draftUrl: buildGmailDraftUrl(existingDraftId),
          });
          return;
        }
        case "collision":
          // 別 actor / 別 user の既存 success → 横取り拒否 (Codex High 1 対応、PR #449 と同等)
          logger.warn("Idempotency collision: existing success doc belongs to different actor/user", {
            tenantId,
            requestId: parsed.requestId,
            currentActorHash: hashEmail(createdByUid),
            currentUserId: userId,
          });
          res.status(409).json({
            error: "invalid_request_id",
            message: "requestId is already used by a different actor or user",
          });
          return;
      }
    } catch (err) {
      logger.error("Failed to acquire pending pdf_draft_logs — refusing to proceed", {
        errorType: "pdf_draft_acquire_failed",
        error: err instanceof Error ? err : new Error(String(err)),
        tenantId,
        requestId: parsed.requestId,
      });
      res.status(503).json({
        error: "gmail_api_transient",
        message: TRANSIENT_RETRY_MESSAGE_JA,
      });
      return;
    }

    // Gmail API draft 作成 (db は handler 先頭で取得済み)
    try {
      const draftResult = await createGmailDraft({
        accessToken: parsed.accessToken,
        to: validatedToEmail,
        // CC 省略時 (ownerEmail 未設定 or 空) は undefined を渡し Cc: ヘッダ自体を出さない
        cc: validatedCcEmail ?? undefined,
        subject,
        body,
        attachment,
      });

      // Issue #435 AC-5: pending → success に状態遷移を記録
      await finalizePdfDraftLog(db, {
        requestId: parsed.requestId,
        tenantId,
        draftId: draftResult.draftId,
        status: "success",
        errorCode: null,
        pdfSizeBytes: attachmentBytes,
      }).catch((err: unknown) => {
        // 監査ログ失敗はレスポンスをブロックしない。logger.error は service 側で出力済み
        logger.warn("Audit finalize failed but draft was created successfully", {
          tenantId,
          requestId: parsed.requestId,
          draftId: draftResult.draftId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

      const response: ProgressPdfDraftResponse = {
        draftId: draftResult.draftId,
        draftUrl: draftResult.draftUrl,
      };
      res.status(201).json(response);
    } catch (err) {
      const gmailErr = err instanceof GmailDraftError ? err : null;
      const errorCode: ProgressPdfDraftErrorCode = gmailErr?.errorCode ?? "gmail_api_error";
      const httpStatus = gmailErr?.httpStatus ?? 502;

      // Issue #435 AC-5: pending → failed に状態遷移を記録 (acquire 済みの場合のみ)
      // acquire 失敗時は既に上で 503 で return しているので、ここに来るのは acquire 成功後
      if (pendingAcquired) {
        await finalizePdfDraftLog(db, {
          requestId: parsed.requestId,
          tenantId,
          draftId: null,
          status: "failed",
          errorCode,
          pdfSizeBytes: attachmentBytes,
        }).catch((auditErr: unknown) => {
          logger.warn("Failed to finalize pdf_draft_logs entry after Gmail failure", {
            errorType: "pdf_draft_audit_finalize_failed_after_gmail_fail",
            tenantId,
            requestId: parsed.requestId,
            primaryErrorCode: errorCode,
            primaryHttpStatus: httpStatus,
            errorMessage: auditErr instanceof Error ? auditErr.message : String(auditErr),
          });
        });
      }

      // SECURITY (I2 / ADR-034 / Issue #437): GmailDraftError の `message` は Gmail API の
      // raw error を含む可能性があるため、logger.error にも HTTP レスポンスにも出さない。
      // 運用追跡には errorCode + httpStatus のみで十分 (Cloud Logging で req/res telemetry を参照)。
      logger.error("Gmail draft creation failed", {
        errorType: "gmail_draft_failed",
        tenantId,
        userId,
        requestId: parsed.requestId,
        errorCode,
        httpStatus,
      });
      // Issue #437: 外部レスポンスには publicMessage (固定文言) のみ返す
      res.status(httpStatus).json({
        error: errorCode,
        message: gmailErr?.publicMessage ?? "Gmail draft creation failed",
      });
    }
  },
);

export const progressPdfDraftRouter = router;
