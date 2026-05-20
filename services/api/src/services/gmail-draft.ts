/**
 * Phase 2: Gmail API `users.drafts.create` で下書きメールを作成する。
 *
 * ADR-034 採用方式。Domain-Wide Delegation ではなく、スーパー管理者本人の OAuth
 * access token (gmail.compose scope) を受け取って per-user で API を呼ぶ。
 * access token は呼び出し後にメモリから破棄、ログには記録しない。
 *
 * MIME 組み立ては multipart/mixed (text/plain + application/pdf attachment)。
 * 件名の日本語は RFC 2047 (=?UTF-8?B?...?=) で encode。
 */

import { google } from "googleapis";
import type { ProgressPdfDraftErrorCode } from "@lms-279/shared-types";

/**
 * Issue #437 (PII フィルタ): GmailDraftError は 2 種類の message を持つ:
 * - `message` (内部診断用): Error 標準フィールド。Gmail API の raw error message が
 *   含まれる可能性があるため、**logger.error / HTTP レスポンスに直接出してはならない**。
 * - `publicMessage` (外部公開用): `errorCode` ごとの固定文言。PII を含まないため
 *   logger.error / HTTP レスポンスの `message` フィールドにそのまま出してよい。
 *
 * SECURITY (I2 / ADR-034): GaxiosError は config.headers.Authorization に
 * access token を保持するため、本クラスは raw error への参照を持たない。
 * 加えて Issue #437 対応で raw error message の外部漏洩も防ぐ。
 */
export const GMAIL_ERROR_PUBLIC_MESSAGES: Readonly<
  Record<ProgressPdfDraftErrorCode, string>
> = Object.freeze({
  bad_request: "Bad request",
  invalid_sections: "Invalid sections",
  invalid_request_id: "Invalid requestId",
  invalid_access_token: "Access token is invalid or expired",
  access_token_owner_mismatch: "Access token owner does not match authenticated user",
  no_sections_selected: "At least one section must be selected",
  user_email_not_configured: "Student email is missing or invalid",
  invalid_owner_email: "Tenant ownerEmail is invalid",
  owner_email_not_set: "Tenant ownerEmail is not configured",
  demo_tenant_not_supported: "Demo tenant is not supported",
  invalid_tenant_id: "Invalid tenant ID",
  invalid_user_id: "Invalid user ID",
  tenant_not_found: "Tenant not found",
  user_not_in_tenant: "User not found in the specified tenant",
  pdf_too_large_for_gmail: "Generated PDF exceeds Gmail attachment limit",
  pdf_generation_failed: "Failed to generate PDF",
  gmail_scope_required: "Gmail compose scope is required (please re-authenticate)",
  gmail_quota_exceeded: "Gmail API quota exceeded — please retry later",
  gmail_api_error: "Gmail API error",
  gmail_api_transient: "Gmail API is temporarily unavailable — please retry",
});

export class GmailDraftError extends Error {
  constructor(
    /**
     * 内部診断用 message (Error 標準フィールド)。
     * Gmail API raw error message が含まれる可能性があるため、外部公開禁止。
     */
    message: string,
    public errorCode: ProgressPdfDraftErrorCode,
    public httpStatus: number,
  ) {
    super(message);
    this.name = "GmailDraftError";
  }

  /**
   * Issue #437: 外部公開用の固定文言 (PII フリー)。
   * logger.error / HTTP レスポンスの `message` フィールドにはこちらを使う。
   */
  get publicMessage(): string {
    return GMAIL_ERROR_PUBLIC_MESSAGES[this.errorCode] ?? "Gmail API error";
  }
}

export interface MimeAttachment {
  filename: string;
  /** MIME type (e.g. "application/pdf") */
  contentType: string;
  /** 添付ファイルのバイト列 */
  content: Buffer;
}

export interface BuildRawMimeMessageInput {
  to: string;
  /**
   * Optional CC header. undefined または空文字 (trim 後) なら Cc: ヘッダを発行しない。
   * route 層で email バリデーション済 (CRLF/カンマ/制御文字を含む値は事前に拒否) の
   * 値のみ渡す前提。library 層でも assertNoCRLF で二重防御する。
   */
  cc?: string;
  subject: string;
  body: string;
  attachment?: MimeAttachment;
}

export interface CreateGmailDraftInput {
  accessToken: string;
  to: string;
  /** Optional CC. 詳細は BuildRawMimeMessageInput.cc 参照 */
  cc?: string;
  subject: string;
  body: string;
  attachment?: MimeAttachment;
}

export interface CreateGmailDraftResult {
  draftId: string;
  draftUrl: string;
}

/** 件名の日本語を RFC 2047 でエンコード */
function encodeMimeHeader(value: string): string {
  // ASCII のみなら encoding 不要
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(value)) return value;
  const base64 = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${base64}?=`;
}

/**
 * RFC 5987 §3.2.1 attr-char 準拠の percent-encoding。
 * `encodeURIComponent` は `*'()!` を encode せず残すため、RFC 5987 ext-value
 * 文法 (`'` が charset/language 区切りに使われる) を破る可能性がある。
 * 厳密パーサ (Outlook の一部) が param ごと無視して ASCII fallback に落とすのを防ぐ。
 */
function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * MIME ヘッダパラメータ (filename / name) を 2026 業界 best practice の
 * dual-form で組み立てる。
 *
 * 経緯: RFC 5322 §3.2.4 quoted-string は ASCII のみ許可、非 ASCII は RFC 5987
 * `param*=UTF-8''<pct-encoded>` で表現するのが標準。しかし Gmail / Outlook は
 * RFC 5987 を解釈せず `filename` を優先するため、純 ASCII fallback だと UI 表示
 * とダウンロードの両方で本来のファイル名が失われる。
 *
 * 業界 de facto (RFC 5987 制定後も多くの client / SMTP server で受理される):
 * `filename` には**生 Unicode を quoted-string で直接書き**、`filename*=` も
 * 併記する dual-form を採用。Gmail / Outlook / Apple Mail は filename を直接
 * 読んで Unicode 表示し、厳密パーサ向けには filename* が動く。
 *
 * 制御文字 (`\x00-\x1f`, `\x7f`) と lone surrogate は事前に呼び出し側
 * (assertSafeFilename) で拒否する前提。
 */
function buildFilenameParam(
  paramName: "filename" | "name",
  value: string,
): string {
  const isAscii = !/[^\x20-\x7e]/.test(value);
  // RFC 5322 quoted-pair: `\` も `"` も escape する
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (isAscii) {
    return `${paramName}="${escaped}"`;
  }
  // 非 ASCII: 生 Unicode quoted-string + RFC 5987 percent-encoded を併記
  return `${paramName}="${escaped}"; ${paramName}*=UTF-8''${rfc5987Encode(value)}`;
}

/** boundary 文字列を生成 (predictable で衝突しないもの) */
function generateBoundary(): string {
  return `lms279_boundary_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * MIME ヘッダ系フィールドに CR/LF が含まれていれば throw する。
 * SECURITY: ヘッダインジェクション (例: To/Subject に \r\nBcc: attacker@... を
 * 注入されて転送先を改ざんされる) を library 層で防ぐ。route 層も検証するが、
 * 将来別 caller (一括送信機能など) が増えたときも安全に保つ二重防御。
 */
function assertNoCRLF(value: string, fieldName: string): void {
  if (/[\r\n]/.test(value)) {
    throw new GmailDraftError(
      `MIME header injection blocked: ${fieldName} contains CR/LF`,
      "gmail_api_error",
      400,
    );
  }
}

/**
 * 添付ファイル名として安全な文字列であることを保証する。
 * - 制御文字 (`\x00-\x1f`, `\x7f`): 一部 MTA で truncate / 拒否 / NUL 終端誤認の原因
 * - lone surrogate (`\uD800-\uDFFF` 単独): rfc5987Encode (encodeURIComponent) が URIError を throw
 *
 * 空文字は本関数では許容する (現状 route 層で必須化されているため二重バリデーションを避ける)。
 */
function assertSafeFilename(value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new GmailDraftError(
      "Invalid filename: contains control character",
      "gmail_api_error",
      400,
    );
  }
  // lone surrogate 検出: high の後に low が来ないペア、または low 単独
  // (encodeURIComponent はこれらで URIError を throw する)
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    throw new GmailDraftError(
      "Invalid filename: contains lone surrogate",
      "gmail_api_error",
      400,
    );
  }
}

/** Buffer / string を base64url にエンコード (Gmail API raw 用) */
function toBase64Url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf.toString("base64url");
}

/**
 * RFC 5322 / MIME multipart メッセージを組み立てて base64url で返す。
 * Gmail API users.drafts.create の raw フィールドに渡す形式。
 *
 * pure function、テストしやすいよう外部依存なし。
 */
export function buildRawMimeMessage(input: BuildRawMimeMessageInput): string {
  const { to, cc, subject, body, attachment } = input;

  // SECURITY: library 層でのヘッダインジェクション二重防御。
  // body 内の CR/LF は base64 エンコードされるため許容。
  assertNoCRLF(to, "to");
  // CC は省略可能。空文字 (trim 後) や undefined のときは Cc: ヘッダを出さない。
  const normalizedCc = typeof cc === "string" ? cc.trim() : "";
  if (normalizedCc.length > 0) {
    assertNoCRLF(normalizedCc, "cc");
  }
  assertNoCRLF(subject, "subject");
  if (attachment) {
    assertNoCRLF(attachment.filename, "attachment.filename");
    assertNoCRLF(attachment.contentType, "attachment.contentType");
    assertSafeFilename(attachment.filename);
  }

  const encodedSubject = encodeMimeHeader(subject);

  /** Cc ヘッダ行を条件付きで挿入するヘルパー */
  const ccLines = normalizedCc.length > 0 ? [`Cc: ${normalizedCc}`] : [];

  if (!attachment) {
    // 添付なしのシンプルメッセージ
    const lines = [
      `To: ${to}`,
      ...ccLines,
      `Subject: ${encodedSubject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(body, "utf-8").toString("base64"),
    ];
    return toBase64Url(lines.join("\r\n"));
  }

  const boundary = generateBoundary();
  // RFC 2046 §5.1 の Content-Type `name=` は RFC 6266 で deprecated。Gmail UI が
  // ASCII fallback を優先する経路で UUID にフォールバックされる観測があるため
  // name= を発行せず Content-Disposition: filename(=/*) のみに統一する。
  const filenameParam = buildFilenameParam("filename", attachment.filename);

  // base64 を 76 文字ごとに改行 (RFC 2045 推奨)
  const attachmentBase64 = attachment.content.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";

  const lines = [
    `To: ${to}`,
    ...ccLines,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf-8").toString("base64"),
    "",
    `--${boundary}`,
    `Content-Type: ${attachment.contentType}`,
    `Content-Disposition: attachment; ${filenameParam}`,
    "Content-Transfer-Encoding: base64",
    "",
    attachmentBase64,
    "",
    `--${boundary}--`,
  ];

  return toBase64Url(lines.join("\r\n"));
}

/**
 * Node.js / undici / gaxios の transport-level error code。
 * これらは一時的なネットワーク不安定で発生し、リトライで回復しうる
 * (ECONNRESET / ETIMEDOUT 等は transient エラーとして扱う)。
 *
 * 未収載の code は gmail_api_error (502) にフォールバックする。本番ログで
 * transient 候補の漏れを発見したら本セットに追加する。
 *
 * export 理由: テスト側で本 Set を再利用し定義の二重化を避けるため。
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
 * googleapis のエラーを ProgressPdfDraftErrorCode に分類する。
 *
 * 評価順 (上位ほど優先):
 *   1. response.status — Gmail API から返された HTTP status (401/403/429/503 等)
 *   2. e.code が数値 / 数値文字列 — HTTP status として扱う (gaxios の歴史的挙動互換)
 *   3. e.code / e.cause?.code が transport code 文字列 (ECONNRESET 等) — transient
 *   4. e.status の存在 — HTTP status として扱う
 *   5. フォールバック (gmail_api_error, httpStatus 502)
 *
 * GaxiosError の構造:
 * - .code: HTTP status (number) または transport code (string)
 * - .cause?.code: undici が wrapping した下層 transport code
 * - .response?.status: HTTP status
 * - .response?.data?.error?.errors?: [{ reason: string, message: string }]
 * - .errors?: [{ reason: string, message: string }]
 */
export function classifyGmailError(err: unknown): GmailDraftError {
  if (err instanceof GmailDraftError) return err;

  const e = err as {
    code?: number | string;
    status?: number;
    cause?: { code?: unknown };
    response?: {
      status?: number;
      data?: { error?: { code?: number; message?: string; errors?: Array<{ reason?: string; message?: string }> } };
    };
    errors?: Array<{ reason?: string; message?: string }>;
    message?: string;
  };

  // e.code が "503" のような数値文字列のとき、それを HTTP status の候補として扱う。
  // "ECONNRESET" 等の非数値文字列は undefined となり、後段の transport code 経路で評価される。
  const httpStatusFromCode =
    typeof e.code === "string" && /^\d+$/.test(e.code) ? Number(e.code) : undefined;
  const status =
    e.response?.status ??
    (typeof e.code === "number" ? e.code : httpStatusFromCode) ??
    e.status ??
    0;

  const errors = e.response?.data?.error?.errors ?? e.errors ?? [];
  const reason = errors[0]?.reason ?? "";
  const message = e.response?.data?.error?.message ?? e.message ?? "Gmail API error";

  // transport-level network error は HTTP status 未確定のときのみ transient 扱い
  // (HTTP status があれば API レイヤの分類を優先する)。
  if (!e.response?.status) {
    const transportCodeFromError =
      typeof e.code === "string" && httpStatusFromCode === undefined ? e.code : undefined;
    const transportCodeFromCause =
      typeof e.cause?.code === "string" ? e.cause.code : undefined;
    const networkCode = transportCodeFromError ?? transportCodeFromCause;
    if (networkCode && TRANSIENT_NETWORK_CODES.has(networkCode)) {
      return new GmailDraftError(message, "gmail_api_transient", 503);
    }
  }

  // 401: invalid_access_token
  if (status === 401) {
    return new GmailDraftError(message, "invalid_access_token", 401);
  }

  // 403: scope 不足の判定
  if (status === 403) {
    if (
      reason === "insufficientPermissions" ||
      reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" ||
      /insufficient/i.test(message) ||
      /scope/i.test(message)
    ) {
      return new GmailDraftError(message, "gmail_scope_required", 403);
    }
    return new GmailDraftError(message, "gmail_api_error", 403);
  }

  // 429: quota / rate limit
  if (status === 429) {
    return new GmailDraftError(message, "gmail_quota_exceeded", 429);
  }

  // 503: transient
  if (status === 503) {
    return new GmailDraftError(message, "gmail_api_transient", 503);
  }

  // 5xx 全般
  if (status >= 500 && status < 600) {
    return new GmailDraftError(message, "gmail_api_error", 502);
  }

  // それ以外 (4xx 含む) は gmail_api_error
  return new GmailDraftError(message, "gmail_api_error", status || 502);
}

/**
 * Gmail Web UI の下書き個別ページ URL を返す。
 * ADR-034 §9 で確定した URL 形式。
 */
export function buildGmailDraftUrl(draftId: string): string {
  return `https://mail.google.com/mail/u/0/?ogbl#drafts/${draftId}`;
}

export interface VerifyAccessTokenOwnerResult {
  /** access token を発行した Google アカウントの email (小文字正規化済) */
  email: string;
  /** Google 側で確認済みの email かどうか (verified_email クレーム) */
  verified: boolean;
}

// SECURITY (Issue #436 / ADR-034): access token の発行元 Google アカウントが
// superAdmin の Firebase Auth email と一致するかを検証するため、Gmail API 呼び出し前に
// `oauth2.tokeninfo` で owner email を取得する。
// - 成功時: { email (lowercased), verified } を返す
// - 401 (token 無効): invalid_access_token を throw (Gmail API 呼び出しと同じ扱い)
// - その他 / network 障害: classifyGmailError 経由で gmail_api_transient / gmail_api_error 等に分類
export async function verifyAccessTokenOwner(
  accessToken: string,
): Promise<VerifyAccessTokenOwnerResult> {
  if (!accessToken) {
    throw new GmailDraftError(
      "accessToken is required",
      "invalid_access_token",
      400,
    );
  }

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });

  try {
    const response = await oauth2.tokeninfo({ access_token: accessToken });
    const email = response.data.email;
    if (!email || typeof email !== "string") {
      throw new GmailDraftError(
        "tokeninfo returned no email",
        "invalid_access_token",
        401,
      );
    }
    return {
      email: email.trim().toLowerCase(),
      verified: response.data.verified_email === true,
    };
  } catch (err) {
    throw classifyGmailError(err);
  }
}

/**
 * Gmail API `users.drafts.create` で下書きを作成する。
 *
 * @throws GmailDraftError 認可・API エラーは errorCode 付きで throw
 */
export async function createGmailDraft(
  input: CreateGmailDraftInput,
): Promise<CreateGmailDraftResult> {
  const { accessToken, to, cc, subject, body, attachment } = input;

  if (!accessToken) {
    throw new GmailDraftError(
      "accessToken is required",
      "invalid_access_token",
      400,
    );
  }

  const raw = buildRawMimeMessage({ to, cc, subject, body, attachment });

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  try {
    const response = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw } },
    });

    const draftId = response.data.id;
    if (!draftId) {
      throw new GmailDraftError(
        "Gmail API returned no draft id",
        "gmail_api_error",
        502,
      );
    }

    return {
      draftId,
      draftUrl: buildGmailDraftUrl(draftId),
    };
  } catch (err) {
    throw classifyGmailError(err);
  }
}

export const __internal = {
  encodeMimeHeader,
  generateBoundary,
  toBase64Url,
  buildFilenameParam,
  rfc5987Encode,
  assertSafeFilename,
};
