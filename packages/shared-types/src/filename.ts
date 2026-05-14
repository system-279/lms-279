/**
 * 進捗 PDF 添付ファイル名を生成する共通ヘルパ。
 *
 * 背景: Issue #366
 * 過去の sanitize ロジック `name.replace(/[^A-Za-z0-9._-]/g, "_")` は
 * 日本語名を一律 `_` に置換し、`progress-___-2026-05-14.pdf` のような
 * 識別不能なファイル名を生成していた。
 *
 * 設計:
 * - Gmail draft 経路: services/api/src/services/gmail-draft.ts の
 *   encodeMimeHeader が RFC 2047 (=?UTF-8?B?...?=) で Unicode を safe に
 *   エンコードするため、filename に日本語を含めても表示は崩れない。
 * - HTTP attachment 経路: services/api/src/routes/super/progress-pdf.ts は
 *   Content-Disposition: filename*=UTF-8''<encoded> (RFC 6266) を発行
 *   しており、モダンブラウザは Unicode filename を正しく扱える。
 * - ブラウザダウンロード経路: <a download> 属性は modern browser で
 *   Unicode をそのまま許容する。
 *
 * 本ヘルパは以下のみを除去する:
 * - OS / HTTP unsafe な特殊文字: / \ : * ? " < > |
 * - 制御文字 (U+0000 - U+001F, U+007F): CR/LF を含む
 *
 * name が空 / 全空白 / sanitize 結果が空 の場合は email にフォールバックする。
 * email も同じ sanitize ロジックを通すが、@ が含まれるためまず置換されない。
 */
export interface BuildProgressPdfFilenameInput {
  /** 受講者名 (null/undefined/空文字許容) */
  name: string | null | undefined;
  /** 受講者 email (name 空の場合の fallback) */
  email: string;
  /** 日付文字列 (YYYY-MM-DD 形式想定。本関数では検証しない) */
  date: string;
}

// 制御文字 (U+0000 - U+001F, U+007F) + OS / HTTP unsafe 特殊文字を _ に置換する。
// 文字クラス内のリテラル制御文字は editor / diff viewer で見えずレビュー事故の温床に
// なるため、エスケープ表記で記述する。
const UNSAFE_CHARS_RE = /[\x00-\x1f\x7f<>:"/\\|?*]/g;

// 受講者名相当の長さ上限 (UTF-16 code unit 数)。
// 日本語 50 文字 ≒ UTF-8 で約 150 bytes。全体 (`progress-` + name + `-YYYY-MM-DD.pdf`) で
// ext4 / NTFS / HFS+ の 255 byte ファイル名制限内に収まる。
const MAX_SANITIZED_LENGTH = 50;

function sanitizeForFilename(value: string): string {
  return value
    .replace(UNSAFE_CHARS_RE, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .trim()
    .slice(0, MAX_SANITIZED_LENGTH);
}

export function buildProgressPdfFilename(input: BuildProgressPdfFilenameInput): string {
  const rawName = (input.name ?? "").trim();
  const sanitizedName = sanitizeForFilename(rawName);
  const safeName = sanitizedName.length > 0 ? sanitizedName : sanitizeForFilename(input.email);
  return `progress-${safeName}-${input.date}.pdf`;
}
