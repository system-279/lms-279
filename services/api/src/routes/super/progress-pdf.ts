/**
 * スーパー管理者向け 受講者進捗 PDF 出力ルート (Phase 1)。
 *
 * POST /api/v2/super/tenants/:tenantId/users/:userId/progress-pdf
 *   body: { requestId: string, sections: ProgressPdfSections }
 *   200:  application/pdf (Buffer)
 *   400:  bad_request (sections/requestId 欠落)
 *   404:  tenant_not_found / user_not_in_tenant
 *   413:  pdf_too_large (PDF サイズが上限超過)
 *   500/503: pdf_generation_failed
 *
 * 認可は親ルータ super-admin.ts の superAdminAuthMiddleware に依存（全 super 配下に適用済）。
 */

import { Router, type Request, type Response } from "express";
import { getFirestore } from "firebase-admin/firestore";
import { renderToBuffer } from "@react-pdf/renderer";
import type {
  ProgressPdfRequest,
  ProgressPdfSectionKey,
  ProgressPdfSections,
} from "@lms-279/shared-types";
import { getDataSource } from "../../datasource/factory.js";
import { validateTenantId } from "../../middleware/tenant.js";
import { buildProgressPdfData, type TenantInfo } from "../../services/progress-pdf.js";
import { ProgressPdfDocument } from "../../services/progress-pdf-document.js";
import { logger } from "../../utils/logger.js";
import { classifyFirestoreError, TRANSIENT_RETRY_MESSAGE_JA } from "../../utils/grpc-errors.js";

const PDF_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const USER_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
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

function parseBody(body: unknown): ProgressPdfRequest | { error: string; message: string } {
  if (!body || typeof body !== "object") {
    return { error: "bad_request", message: "Request body is required" };
  }
  const obj = body as Record<string, unknown>;
  const { requestId, sections } = obj;

  // requestId: Phase 1 ではログ用識別子としてのみ使用。Phase 2 で idempotency key として活用予定。
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
    return { error: "invalid_request_id", message: "requestId must be a non-empty string (<=128 chars)" };
  }
  const parsedSections = parseSections(sections);
  if (!parsedSections) {
    return {
      error: "invalid_sections",
      message: `sections must include 7 boolean flags: ${SECTION_KEYS.join(", ")}`,
    };
  }
  return { requestId, sections: parsedSections };
}

router.post(
  "/tenants/:tenantId/users/:userId/progress-pdf",
  async (req: Request, res: Response) => {
    const rawTenantId = req.params.tenantId as string;
    const rawUserId = req.params.userId as string;

    // パストラバーサル防止: 英数字+ハイフン+アンダースコアのみ許可
    const tenantId = validateTenantId(rawTenantId);
    if (!tenantId) {
      res.status(400).json({
        error: "invalid_tenant_id",
        message: "Invalid tenant ID. Must be 1-64 alphanumeric characters, hyphens, or underscores.",
      });
      return;
    }
    // demo テナントは共有 InMemoryDataSource を返すため越境チェックが効かない (ADR-032)。
    // スーパー管理者が demo を対象にする運用上の必要もないので拒否。
    if (tenantId === "demo") {
      res.status(400).json({
        error: "demo_tenant_not_supported",
        message: "Demo tenant is not supported for progress PDF generation",
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

    try {
      const db = getFirestore();
      const tenantDoc = await db.collection("tenants").doc(tenantId).get();
      if (!tenantDoc.exists) {
        res.status(404).json({ error: "tenant_not_found", message: "Tenant not found" });
        return;
      }
      const tenantData = tenantDoc.data() ?? {};
      const tenant: TenantInfo = {
        id: tenantId,
        name: typeof tenantData.name === "string" ? tenantData.name : tenantId,
        ownerEmail: typeof tenantData.ownerEmail === "string" && tenantData.ownerEmail.length > 0
          ? tenantData.ownerEmail
          : null,
      };

      // tenant scope の DataSource を取得（demo は上で弾いているので isDemo は常に false）
      const dataSource = getDataSource({ tenantId, isDemo: false });

      const pdfData = await buildProgressPdfData({
        dataSource,
        tenant,
        userId,
      });

      const buffer = await renderToBuffer(
        ProgressPdfDocument({ data: pdfData, sections: parsed.sections }),
      );

      if (buffer.length > PDF_MAX_BYTES) {
        logger.warn("Progress PDF size exceeded limit", {
          tenantId,
          userId,
          sizeBytes: buffer.length,
          limitBytes: PDF_MAX_BYTES,
          requestId: parsed.requestId,
        });
        res.status(413).json({
          error: "pdf_too_large",
          message: `Generated PDF exceeds ${PDF_MAX_BYTES} bytes`,
        });
        return;
      }

      const filenameSafeName = (pdfData.user.name ?? pdfData.user.email).replace(/[^A-Za-z0-9._-]/g, "_");
      const dateStr = pdfData.generatedAt.slice(0, 10);
      const filename = `progress-${filenameSafeName}-${dateStr}.pdf`;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.setHeader("Cache-Control", "no-store");
      res.status(200).send(buffer);
    } catch (err) {
      if (err instanceof Error && err.message === "user_not_in_tenant") {
        res.status(404).json({
          error: "user_not_in_tenant",
          message: "User not found in the specified tenant",
        });
        return;
      }
      const { grpcCode, isTransient } = classifyFirestoreError(err);
      logger.error("Failed to generate progress PDF", {
        errorType: "progress_pdf_generation_failed",
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
    }
  },
);

export const progressPdfRouter = router;
