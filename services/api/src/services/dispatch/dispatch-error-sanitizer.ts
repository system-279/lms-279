/**
 * Audit log / Error Reporting に出力する前にエラーメッセージから PII を除去するユーティリティ。
 *
 * 設計仕様書 §6.5 / NFR-11 / AC-33 (PII sanitize) に対応。
 * Codex セカンドオピニオン Important-7 (PII ログ漏洩) + PR #442 review Critical 2 (取りこぼし拡張)
 * を反映済み。
 *
 * 対象 PII / トークン:
 *   - email アドレス (一般形式)
 *   - Google OAuth2 access token (ya29.<...>)
 *   - JWT 3-part (eyJ<...>.<...>.<...>) — ID token / Bearer token 本体
 *   - Refresh token (1//<...>)
 *   - Google API key (AIza<35 chars>)
 *   - Authorization: Bearer <token>
 *   - MIME ヘッダ行 (To/Cc/Bcc/From/Reply-To/Sender、folded continuation 含む)
 *
 * 置換順序:
 *   MIME ヘッダ全体 → Bearer (token 切り出し前) → JWT → access_token → refresh_token →
 *   API key → email の順。順序を変更すると "To: alice@x.com" のような複合ケースで
 *   ヘッダ全体ではなく email だけ消えて "To:" 残骸が出る等の中途半端 redaction になる。
 *
 * 文字数上限: DISPATCH_CONSTRAINTS.SANITIZED_ERROR_MESSAGE_MAX_LENGTH (現在 1024)
 *   UTF-8 マルチバイト境界を割らないよう、置換後に Array.from で grapheme 単位で
 *   slice する。
 */

import { DISPATCH_CONSTRAINTS } from "@lms-279/shared-types";

// === 正規表現 ===
// email: RFC 5322 完全対応はしない、Gmail API エラーで観測される一般形式に絞る。
// IDN (国際化ドメイン) / quoted-string local-part 等の特殊形式は対象外
// (それらが PII として漏れた場合は別途検知層を設ける想定)。
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Google OAuth2 access token (ya29 プレフィックス)
const ACCESS_TOKEN_RE = /ya29\.[A-Za-z0-9_.-]+/g;

// JWT 3-part (eyJ で始まる base64url の 3 セクション)。
// ID token / OIDC ID token / Bearer の中身 を broadly キャッチ。
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

// Google OAuth2 refresh token (1// プレフィックス)
const REFRESH_TOKEN_RE = /1\/\/[A-Za-z0-9_-]+/g;

// Google API key (AIza + 35 chars の固定形式)
const API_KEY_RE = /AIza[0-9A-Za-z_-]{35}/g;

// Authorization: Bearer <token>。token 部分には ya29 / JWT 等が入りうるため、
// access_token / JWT より先に処理して "Bearer ya29..." → "[BEARER]" にする。
const BEARER_RE = /Bearer\s+[A-Za-z0-9_.-]+/g;

// MIME ヘッダ行 (To/Cc/Bcc/From/Reply-To/Sender)、
// folded header (次行頭が空白文字で継続するパターン RFC 5322 §2.2.3) を含む。
const MIME_HEADER_RE =
  /(?:To|Cc|Bcc|From|Reply-To|Sender):\s*[^\r\n]+(?:\r?\n[ \t][^\r\n]*)*/gi;

const MAX_LENGTH = DISPATCH_CONSTRAINTS.SANITIZED_ERROR_MESSAGE_MAX_LENGTH;

/**
 * UTF-8 マルチバイト境界を割らない truncate。
 * Array.from は code point 単位でイテレートするためサロゲートペア / 結合文字も安全。
 */
function safeTruncate(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  return Array.from(s).slice(0, maxLength).join("");
}

export function sanitizeErrorForAudit(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const sanitized = raw
    .replace(MIME_HEADER_RE, "[MIME_HEADER]")
    .replace(BEARER_RE, "[BEARER]")
    .replace(JWT_RE, "[JWT]")
    .replace(ACCESS_TOKEN_RE, "[ACCESS_TOKEN]")
    .replace(REFRESH_TOKEN_RE, "[REFRESH_TOKEN]")
    .replace(API_KEY_RE, "[API_KEY]")
    .replace(EMAIL_RE, "[EMAIL]");
  return safeTruncate(sanitized, MAX_LENGTH);
}
