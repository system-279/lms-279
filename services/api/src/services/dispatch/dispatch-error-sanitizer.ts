/**
 * Audit log / Error Reporting に出力する前にエラーメッセージから PII を除去するユーティリティ。
 *
 * 設計仕様書 §6.5 / NFR-11 / AC-33 (PII sanitize) に対応。
 * Codex セカンドオピニオン Important-7 (PII ログ漏洩) を踏まえ、Gmail / Gaxios の
 * raw エラーメッセージに含まれる可能性がある email / access_token / Bearer / MIME headers を
 * [REDACTED] プレースホルダーに置換し、上限 1024 文字で truncate する。
 *
 * 順序は重要: MIME_HEADER → Bearer → access_token → email の順で置換すると、
 * "To: alice@x.com" のような複合ケースで MIME ヘッダ行全体が先に消える。
 */

import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";

// email: RFC 5322 完全対応はしない、Gmail API エラーで観測される一般形式に絞る
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Google OAuth2 access token (ya29 プレフィックス)
const ACCESS_TOKEN_RE = /ya29\.[A-Za-z0-9_.-]+/g;
// Authorization: Bearer <token>
const BEARER_RE = /Bearer\s+[A-Za-z0-9_.-]+/g;
// MIME ヘッダ行 (1 行単位、改行で終わるかメッセージ末尾まで)
const MIME_HEADER_RE = /(?:To|Cc|Bcc|From):\s*[^\r\n]+/gi;

const MAX_LENGTH = DISPATCH_CONSTRAINTS.SANITIZED_ERROR_MESSAGE_MAX_LENGTH;

export function sanitizeErrorForAudit(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // 順序: MIME ヘッダ全体 → Bearer → access token → email
  // (Bearer の token 部分が ya29 形式の場合があるため Bearer を先に処理)
  return raw
    .replace(MIME_HEADER_RE, "[MIME_HEADER]")
    .replace(BEARER_RE, "[BEARER]")
    .replace(ACCESS_TOKEN_RE, "[ACCESS_TOKEN]")
    .replace(EMAIL_RE, "[EMAIL]")
    .slice(0, MAX_LENGTH);
}
