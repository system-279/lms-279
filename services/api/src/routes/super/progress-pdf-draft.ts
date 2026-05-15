/**
 * スーパー管理者向け 受講者進捗 PDF Gmail 下書き作成ルート (Phase 2)。
 *
 * POST /api/v2/super/tenants/:tenantId/users/:userId/progress-pdf-draft
 *   body: { requestId: string, sections: ProgressPdfSections, accessToken: string }
 *   201:  { draftId, draftUrl }
 *   400:  bad_request / invalid_sections / invalid_request_id / invalid_access_token
 *         / demo_tenant_not_supported / invalid_tenant_id / invalid_user_id
 *         / no_sections_selected / owner_email_not_set
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
  type MimeAttachment,
} from "../../services/gmail-draft.js";
import { recordPdfDraftLog } from "../../services/pdf-draft-audit.js";
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

    // Evaluator MEDIUM-2 対応: idempotency 重複ガード
    // 同一 requestId で既に success ログがあれば、Gmail draft 再作成せず既存結果を返す。
    // 確認失敗時は新規作成にフォールバック (idempotency check のためにメイン処理を止めない)。
    try {
      const existingLog = await db
        .collection("tenants")
        .doc(tenantId)
        .collection("pdf_draft_logs")
        .doc(parsed.requestId)
        .get();
      if (existingLog.exists) {
        const data = existingLog.data();
        if (data && data.status === "success" && typeof data.draftId === "string") {
          const existingDraftId = data.draftId;
          const response: ProgressPdfDraftResponse = {
            draftId: existingDraftId,
            draftUrl: buildGmailDraftUrl(existingDraftId),
          };
          res.status(200).json(response);
          return;
        }
        // status=failed の場合は再試行を許容するためフォールスルー
      }
    } catch (err) {
      logger.warn("Failed to check idempotency for pdf_draft_logs (continuing with new draft)", {
        tenantId,
        requestId: parsed.requestId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }

    // tenant doc + DataSource 取得 (Phase 1 と同じ)
    let tenant: TenantInfo;
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

      // ownerEmail 未設定なら 400 (FE 側でボタン disabled だが二重防御)
      // Evaluator MEDIUM 対応: ヘッダインジェクション防止 (CR/LF を含む値は拒否)
      if (!tenant.ownerEmail || /[\r\n]/.test(tenant.ownerEmail)) {
        res.status(400).json({
          error: "owner_email_not_set",
          message: "Tenant ownerEmail is not configured or contains invalid characters",
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
          ownerEmail: tenant.ownerEmail,
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
      });
      subject = template.subject;
      body = template.body;

      const dateStr = pdfData.generatedAt.slice(0, 10);
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

    // Gmail API draft 作成 (db は handler 先頭で取得済み)
    try {
      const draftResult = await createGmailDraft({
        accessToken: parsed.accessToken,
        to: tenant.ownerEmail as string,
        subject,
        body,
        attachment,
      });

      // 成功監査ログ
      await recordPdfDraftLog(db, {
        requestId: parsed.requestId,
        tenantId,
        createdByUid,
        createdByEmail,
        userId,
        ownerEmail: tenant.ownerEmail,
        draftId: draftResult.draftId,
        status: "success",
        errorCode: null,
        sections: parsed.sections,
        pdfSizeBytes: attachmentBytes,
      }).catch((err: unknown) => {
        // 監査ログ失敗はレスポンスをブロックしない。logger.error は service 側で出力済み
        logger.warn("Audit log write failed but draft was created successfully", {
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

      // 失敗監査ログ
      await recordPdfDraftLog(db, {
        requestId: parsed.requestId,
        tenantId,
        createdByUid,
        createdByEmail,
        userId,
        ownerEmail: tenant.ownerEmail,
        draftId: null,
        status: "failed",
        errorCode,
        sections: parsed.sections,
        pdfSizeBytes: attachmentBytes,
      }).catch((auditErr: unknown) => {
        // 監査ログ失敗はレスポンスをブロックしないが、サイレント化せず警告ログを残す
        // (Gmail API 失敗 + 監査ログ失敗の二重失敗を可視化)
        logger.warn("Failed to record failed pdf_draft_logs entry (Gmail also failed)", {
          errorType: "pdf_draft_audit_write_failed_after_gmail_fail",
          tenantId,
          requestId: parsed.requestId,
          primaryErrorCode: errorCode,
          primaryHttpStatus: httpStatus,
          errorMessage: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      });

      // SECURITY (I2 / ADR-034): GmailDraftError は raw GaxiosError 参照を持たない
      // 設計 (gmail-draft.ts §GmailDraftError) のため、ここでは分類済みの
      // errorCode / httpStatus / message のみを記録する。
      logger.error("Gmail draft creation failed", {
        errorType: "gmail_draft_failed",
        tenantId,
        userId,
        requestId: parsed.requestId,
        errorCode,
        httpStatus,
        errorMessage: gmailErr?.message ?? (err instanceof Error ? err.message : "unknown error"),
      });
      res.status(httpStatus).json({
        error: errorCode,
        message: gmailErr?.message ?? "Gmail draft creation failed",
      });
    }
  },
);

export const progressPdfDraftRouter = router;
