/**
 * super_dispatch_audit_logs 書き込みの薄い service layer。
 *
 * 設計仕様書 §4.1.5、§6.5、NFR-4 / NFR-11、AC-33 対応。
 *
 * 責務:
 *   - auditId 生成 (uuid v4)
 *   - createdAt / ttlExpireAt 算出
 *   - DispatchStorage.appendAuditLog に委譲 (best-effort、例外を caller に伝搬しない)
 *   - errorMessage が渡されている場合は **念のため** sanitizeErrorForAudit で
 *     redaction (caller 側で sanitize 漏れ防止の二重防御)
 *
 * 設計仕様書 §6.1「super_dispatch_audit_logs 書き込み失敗は警告ログのみ、
 * レスポンスをブロックしない」原則を本 layer で構造的に保証する。
 *
 * 注意:
 *   - storage 側の appendAuditLog が throw した場合でも本関数は warning ログを
 *     出して resolve する (caller の業務処理を block しない)
 *   - audit 書き込みの可観測性は caller 側の logger.warn でカバーする
 */

import { randomUUID } from "node:crypto";
import type { DispatchAuditLog } from "@lms-279/shared-types";
import {
  DISPATCH_AUDIT_TTL_MS,
  type DispatchStorage,
} from "./dispatch-storage.js";
import { sanitizeErrorForAudit } from "./dispatch-error-sanitizer.js";

export interface RecordAuditLogInput {
  runId: string;
  /** run 開始時刻 (caller が run lock 取得時の triggeredAt を保持して渡す) */
  runStartedAt: string;
  eventType: DispatchAuditLog["eventType"];
  tenantId?: string | null;
  userId?: string | null;
  /** sanitized error code (PII を含まない短い識別子) */
  errorCode?: string | null;
  /**
   * error message。`null` 指定なら no-op、`string` / `Error` / その他 `unknown` は
   * すべて `sanitizeErrorForAudit` で string 化 + PII redaction する。
   *
   * 二重 sanitize 安全性: caller が既に sanitize 済の string を渡しても、
   * `[EMAIL]` 等の redaction marker は再 sanitize しても変化しない冪等性を持つ
   * ため安全。本 layer での sanitize は caller の漏れ防止 (NFR-11 二重防御)。
   */
  errorMessage?: unknown;
  durationMs?: number | null;
  /** 現在時刻 (テスト時固定可、Date 注入) */
  now: Date;
  /** auditId 生成を差し替えたい場合 (主にテスト) */
  auditIdGenerator?: () => string;
}

/**
 * Audit log を append する。書き込み失敗時も throw せず warning ログを出して
 * resolve する (best-effort)。
 *
 * caller 側で本関数を await しても安全 (Gmail 送信成功後の audit 失敗で本来の
 * 送信成功状態を巻き戻さない原則、設計仕様書 §6.1)。
 */
export async function recordAuditLog(
  storage: DispatchStorage,
  input: RecordAuditLogInput,
  // 警告ログ注入 (テストで spy)、既定で console.warn
  warn: (message: string, meta: Record<string, unknown>) => void = (msg, meta) =>
    console.warn(msg, meta),
): Promise<void> {
  const createdAt = input.now.toISOString();
  const ttlExpireAt = new Date(
    input.now.getTime() + DISPATCH_AUDIT_TTL_MS,
  ).toISOString();
  const auditId = (input.auditIdGenerator ?? randomUUID)();

  // errorMessage を null/undefined/string/unknown いずれでも安全に正規化
  let sanitizedMessage: string | null = null;
  if (input.errorMessage !== null && input.errorMessage !== undefined) {
    sanitizedMessage = sanitizeErrorForAudit(input.errorMessage);
  }

  try {
    await storage.appendAuditLog({
      auditId,
      runId: input.runId,
      runStartedAt: input.runStartedAt,
      eventType: input.eventType,
      tenantId: input.tenantId ?? null,
      userId: input.userId ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: sanitizedMessage,
      durationMs: input.durationMs ?? null,
      createdAt,
      ttlExpireAt,
    });
  } catch (err) {
    // best-effort: 業務処理 block しない、観測性は warning ログのみ
    warn("dispatch-audit: appendAuditLog failed (suppressed)", {
      runId: input.runId,
      eventType: input.eventType,
      tenantId: input.tenantId ?? null,
      userId: input.userId ?? null,
      // err message は sanitize して再 PII 漏洩を防ぐ
      errorMessage: sanitizeErrorForAudit(err),
    });
  }
}
