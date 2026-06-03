/**
 * DXcollege 自動完了通知の DWD なりすまし送信 (Gmail API users.messages.send)。
 *
 * 設計仕様書 §3.1 / FR-5 改訂 / NFR-9 / AC-3 / AC-32 / Phase 3 完了条件:
 *   - DWD JWT 生成 (gmail-client.ts 経由、subject=実 mailbox、scope=gmail.send)
 *   - MIME 組立 (添付なし、From=SendAs エイリアス、To=受講者本人、Cc=配列)
 *   - 429 / 503 / transient ネットワークエラーで exponential backoff retry (最大 3 回)
 *   - 401 / 403 / 4xx は即時 throw (caller 側で dispatch-403-classifier 等で分類)
 *   - CC 配列空のとき Cc: ヘッダを省略 (空ヘッダ生成防止、Phase 3 完了条件)
 *
 * SendAs 方針 (ADR-037 案 X):
 *   - JWT subject = 実在 mailbox (`system@279279.net`、DXCOLLEGE_DISPATCH_SUBJECT env)
 *   - MIME `From:` = `dxcollege@279279.net` (DXCOLLEGE_SENDER_EMAIL env、SendAs 登録済)
 *   - Gmail API は subject mailbox の context で動作し、SendAs 登録済の alias を
 *     `From:` に許可する。SendAs 設定漏れの場合は 400 invalidFrom 等で失敗 (caller 検知)
 *
 * 非責務:
 *   - エラー分類: caller (run-completion-notifications.ts) が
 *     dispatch-403-classifier.ts と組み合わせて scope_revoked / user_permanent を判定
 *   - Reservation 状態更新: caller の責務 (reservation.ts)
 *   - PII ハッシュ化: caller の責務 (完了後 recipientToHash 等を Firestore に書く際)
 */

import { randomBytes } from "node:crypto";

import { getGmailClientForSender } from "./gmail-client.js";

const MAX_ATTEMPTS = 3;
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 4000;

/**
 * Node.js / undici / gaxios の transport-level error code (transient 候補)。
 * 既存 gmail-draft.ts の TRANSIENT_NETWORK_CODES と意図的に同期させる。重複は
 * §5.4「PR #434 影響ゼロ」遵守のため受容、将来 common util へ抽出予定。
 */
export const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ESOCKETTIMEDOUT",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * HTTP status / 例外を transient (retry 可) と判定するか。
 * - 429 / 503 → transient (Gmail API レート制限・一時障害)
 * - 上記 transport code → transient (ネットワーク不安定)
 * - その他 → permanent (caller 側で 401/403/4xx を分類)
 */
export function isTransientGmailError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    response?: { status?: number };
    code?: unknown;
    cause?: { code?: unknown };
  };
  const status = e.response?.status;
  if (status === 429 || status === 503) return true;
  const code = typeof e.code === "string" ? e.code : null;
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  const causeCode = typeof e.cause?.code === "string" ? e.cause.code : null;
  if (causeCode && TRANSIENT_NETWORK_CODES.has(causeCode)) return true;
  return false;
}

/** 件名 (subject) の日本語を RFC 2047 で base64 エンコード */
export function encodeMimeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  const base64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${base64}?=`;
}

/**
 * MIME ヘッダ系フィールドの CRLF 注入を library 層で阻止 (二重防御)。
 *
 * 注意: completion-notification-mail.ts の同名関数は **空文字 reject を持たない**
 * (本関数とは責務範囲が異なる)。本関数は MIME ヘッダ行 (`From:` / `To:` /
 * `Subject:` / `Cc:`) に直接乗る値を扱うため、空文字は受信側で空ヘッダになり
 * 配送拒否や受信側 UI 不具合の原因となるため reject する。caller の Phase 4
 * dispatcher は env から fromEmail / subjectEmail を渡すため空文字発生時は
 * env 未設定のバグであり、ここで早期検出する。
 */
function assertHeaderSafe(value: string, fieldName: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`gmail-dwd-send: ${fieldName} must be a non-empty string`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `gmail-dwd-send: ${fieldName} contains CR/LF (header injection blocked)`,
    );
  }
}

export interface BuildCompletionMimeInput {
  /** MIME From (SendAs エイリアス、`dxcollege@279279.net` 等) */
  fromEmail: string;
  /** To (受講者本人、1 件のみ) */
  to: string;
  /** Cc 配列 (cc-email-validator で validate + dedup 済)。空配列なら Cc ヘッダ省略 */
  cc: readonly string[];
  /** 件名 */
  subject: string;
  /** 本文 (text/plain UTF-8) */
  body: string;
}

/**
 * 添付ファイル 1 件の MIME 表現。
 *
 * 設計仕様書 Phase 3 PR 3b / AC-PR-12:
 *   - filename: UTF-8 string、ASCII safe → filename="..." のみ、非 ASCII → RFC 2231 dual-form
 *   - contentType: MIME type (例 "application/pdf")
 *   - data: バイナリ (Buffer)。base64 encode + 76 char wrap (RFC 2045 §6.8) して MIME に埋め込む
 */
export interface MessageAttachment {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface BuildMessageMimeInput extends BuildCompletionMimeInput {
  /** 添付ファイル配列。空 / 未指定なら text/plain 単独 (buildCompletionMime と byte-for-byte 一致) */
  attachments?: readonly MessageAttachment[];
  /** boundary 文字列。テスト用に固定可能。未指定時は crypto.randomBytes(16) hex (32 char) で生成 */
  boundary?: string;
}

/** RFC 2046 §5.1.1 の boundary char subset (digit / alpha / 一部記号) を満たすか */
function isValidBoundary(value: string): boolean {
  // RFC 2046 §5.1.1: bcharsnospace = DIGIT / ALPHA / "'" / "(" / ")" / "+" / "_" / "," / "-" / "." / "/" / ":" / "=" / "?"
  return /^[A-Za-z0-9_'()+,\-./:=?]+$/.test(value);
}

function generateBoundary(): string {
  // 16 byte → 32 hex char (entropy 128 bit)、prefix で boundary 識別を明示
  return `boundary_${randomBytes(16).toString("hex")}`;
}

/** RFC 2045 §6.8 に従い base64 を 76 文字ごとに CRLF で折り返す */
function wrapBase64(data: Buffer, lineLen = 76): string {
  const base64 = data.toString("base64");
  if (base64.length <= lineLen) return base64;
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += lineLen) {
    lines.push(base64.substring(i, i + lineLen));
  }
  return lines.join("\r\n");
}

/**
 * RFC 2231 filename* の値を percent-encode する。
 *
 * encodeURIComponent は RFC 3986 unreserved subset である `!'()*` を encode しないが、
 * RFC 5987 §3.2.1 attr-char は `'!()*` を許可していないため、これら 5 文字も
 * 明示 percent-encode する。`'` は charset/lang 区切りに、`(` `)` は厳密 parser
 * (Outlook の一部バージョン等) で filename* parse 失敗の原因となる。
 *
 * 既存 gmail-draft.ts の rfc5987Encode と同等の挙動。将来 mime-builder 共通化時に
 * 1 つの helper に集約予定 (Phase 4 OQ)。
 */
function encodeRFC2231Value(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** 添付 part 1 件の MIME 表現を構築 */
function buildAttachmentPart(
  attachment: MessageAttachment,
  boundary: string,
): string {
  assertHeaderSafe(attachment.filename, "attachment.filename");
  assertHeaderSafe(attachment.contentType, "attachment.contentType");

  // RFC 2231 dual-form: ASCII safe なら filename="..." のみ、非 ASCII なら
  // filename="<rfc2047>" + filename*=UTF-8''<percent-encoded> 両方を出力
  // (前者は legacy client 互換、後者は RFC 2231 modern client)
  const isAsciiPrintable = !/[^\x20-\x7E]/.test(attachment.filename);
  const dispositionLine = isAsciiPrintable
    ? `Content-Disposition: attachment; filename="${attachment.filename}"`
    : `Content-Disposition: attachment; filename="${encodeMimeHeader(
        attachment.filename,
      )}"; filename*=UTF-8''${encodeRFC2231Value(attachment.filename)}`;

  return [
    `--${boundary}`,
    `Content-Type: ${attachment.contentType}`,
    "Content-Transfer-Encoding: base64",
    dispositionLine,
    "",
    wrapBase64(attachment.data),
  ].join("\r\n");
}

/**
 * 任意添付対応の raw MIME メッセージを base64url で返す (Phase 3 PR 3b)。
 *
 * 設計:
 *   - attachments 空 / 未指定 → text/plain 単独 (旧 buildCompletionMime と byte-for-byte 一致、AC-PR-14)
 *   - attachments あり → multipart/mixed (boundary 区切り、text/plain part + 添付 part)
 *   - 添付 base64 は 76 char で wrap (RFC 2045 §6.8)
 *   - filename は ASCII printable → `filename="..."` のみ、非 ASCII → RFC 2231 dual-form
 *
 * Gmail API `users.messages.send` の raw フィールドに渡す形式。
 */
export function buildMessageMime(input: BuildMessageMimeInput): string {
  const {
    fromEmail,
    to,
    cc,
    subject,
    body,
    attachments,
    boundary: inputBoundary,
  } = input;

  assertHeaderSafe(fromEmail, "fromEmail");
  assertHeaderSafe(to, "to");
  assertHeaderSafe(subject, "subject");

  if (!Array.isArray(cc)) {
    throw new Error("gmail-dwd-send: cc must be an array");
  }
  for (const entry of cc) {
    assertHeaderSafe(entry, "cc[]");
  }
  const ccLines = cc.length > 0 ? [`Cc: ${cc.join(", ")}`] : [];

  const encodedSubject = encodeMimeHeader(subject);
  const hasAttachments = attachments !== undefined && attachments.length > 0;

  if (!hasAttachments) {
    // text/plain 単独 (buildCompletionMime と byte-for-byte 一致を保証する経路)
    const headerLines: string[] = [
      `From: ${fromEmail}`,
      `To: ${to}`,
      ...ccLines,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(body, "utf-8").toString("base64"),
    ];
    return Buffer.from(headerLines.join("\r\n"), "utf-8").toString("base64url");
  }

  // multipart/mixed (添付あり)
  const boundary = inputBoundary ?? generateBoundary();
  if (!isValidBoundary(boundary)) {
    throw new Error(
      "gmail-dwd-send: boundary contains invalid characters (RFC 2046 §5.1.1)",
    );
  }

  const headers = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    ...ccLines,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
  ].join("\r\n");

  const textPart = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf-8").toString("base64"),
  ].join("\r\n");

  // Buffer.concat ベースで raw を組み立てて peak メモリを抑制 (AC-PR-13 5MB PDF 想定)。
  // 旧実装の template literal concat は V8 ConsString rope → Buffer.from(rope) flatten で
  // 中間 buffer が double 確保され、5MB PDF (base64 6.7MB) で peak ~12-13MB だった。
  // Buffer.concat は各 part を独立 alloc + 1 回の output alloc のみで peak ~7MB に削減。
  const separator = Buffer.from("\r\n", "utf-8");
  const rawParts: Buffer[] = [
    Buffer.from(headers, "utf-8"),
    separator,
    Buffer.from(textPart, "utf-8"),
  ];
  for (const a of attachments) {
    rawParts.push(separator);
    rawParts.push(Buffer.from(buildAttachmentPart(a, boundary), "utf-8"));
  }
  rawParts.push(Buffer.from(`\r\n--${boundary}--`, "utf-8"));
  return Buffer.concat(rawParts).toString("base64url");
}

/**
 * 完了通知メールの raw MIME メッセージを base64url で返す。
 * Gmail API `users.messages.send` の raw フィールドに渡す形式。
 *
 * 添付なし固定 (Phase 3 仕様: 進捗 PDF は PR 3b の `buildMessageMime` で別途対応)。
 * Phase 3 PR 3b 以降は `buildMessageMime` の wrapper (byte-for-byte 互換、AC-PR-14)。
 */
export function buildCompletionMime(input: BuildCompletionMimeInput): string {
  return buildMessageMime(input);
}

export interface SendCompletionMailInput {
  /** DWD JWT subject (実在 mailbox、`DXCOLLEGE_DISPATCH_SUBJECT` env) */
  subjectEmail: string;
  /** MIME From ヘッダ (SendAs alias、`DXCOLLEGE_SENDER_EMAIL` env) */
  fromEmail: string;
  /** To (受講者本人) */
  to: string;
  /** Cc 配列 (空可) */
  cc: readonly string[];
  /** 件名 */
  subject: string;
  /** 本文 (text/plain UTF-8) */
  body: string;
}

export interface SendCompletionMailResult {
  /** Gmail API が返した messageId (完了通知レコードに保存) */
  messageId: string;
  /** 最終的に成功したのが何回目の attempt か (audit 用) */
  attempts: number;
}

export interface SendCompletionMailOptions {
  /** retry の sleep 注入点 (テスト時は同期 resolve で短縮) */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gmail API users.messages.send で完了通知を送信する。
 * 429 / 503 / transient ネットワークエラーは exponential backoff で最大
 * MAX_ATTEMPTS 回まで retry。それ以外は 1 回目で throw。
 *
 * 戻り値の messageId は caller が completion_notifications.messageId に保存する。
 *
 * @throws raw Gmail API error (caller 側で dispatch-403-classifier 等で分類)
 */
export async function sendCompletionMail(
  input: SendCompletionMailInput,
  options: SendCompletionMailOptions = {},
): Promise<SendCompletionMailResult> {
  const { subjectEmail, fromEmail, to, cc, subject, body } = input;
  const sleep = options.sleep ?? defaultSleep;

  const raw = buildCompletionMime({ fromEmail, to, cc, subject, body });
  const gmail = await getGmailClientForSender(subjectEmail, fromEmail);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      const messageId = response?.data?.id;
      if (typeof messageId !== "string" || messageId.length === 0) {
        throw new Error("Gmail API send returned no messageId");
      }
      return { messageId, attempts: attempt };
    } catch (err) {
      lastError = err;
      const transient = isTransientGmailError(err);
      if (!transient || attempt === MAX_ATTEMPTS) {
        throw err;
      }
      const backoffMs = Math.min(
        BACKOFF_INITIAL_MS * 2 ** (attempt - 1),
        BACKOFF_MAX_MS,
      );
      await sleep(backoffMs);
    }
  }
  // ループ脱出パスは throw 済のため到達不可だが TypeScript の網羅性のために残す
  throw lastError;
}
