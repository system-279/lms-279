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

// SECURITY (I2 / ADR-034): GaxiosError は config.headers.Authorization に
// access token を保持するため、本クラスは raw error への参照を持たない。
// 分類済みの errorCode / httpStatus / message のみを公開する。
export class GmailDraftError extends Error {
  constructor(
    message: string,
    public errorCode: ProgressPdfDraftErrorCode,
    public httpStatus: number,
  ) {
    super(message);
    this.name = "GmailDraftError";
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
  subject: string;
  body: string;
  attachment?: MimeAttachment;
}

export interface CreateGmailDraftInput {
  accessToken: string;
  to: string;
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
  const { to, subject, body, attachment } = input;

  // SECURITY: library 層でのヘッダインジェクション二重防御。
  // body 内の CR/LF は base64 エンコードされるため許容。
  assertNoCRLF(to, "to");
  assertNoCRLF(subject, "subject");
  if (attachment) {
    assertNoCRLF(attachment.filename, "attachment.filename");
    assertNoCRLF(attachment.contentType, "attachment.contentType");
  }

  const encodedSubject = encodeMimeHeader(subject);

  if (!attachment) {
    // 添付なしのシンプルメッセージ
    const lines = [
      `To: ${to}`,
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
  const encodedFilename = encodeMimeHeader(attachment.filename);

  // base64 を 76 文字ごとに改行 (RFC 2045 推奨)
  const attachmentBase64 = attachment.content.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";

  const lines = [
    `To: ${to}`,
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
    `Content-Type: ${attachment.contentType}; name="${encodedFilename}"`,
    `Content-Disposition: attachment; filename="${encodedFilename}"`,
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

/**
 * Gmail API `users.drafts.create` で下書きを作成する。
 *
 * @throws GmailDraftError 認可・API エラーは errorCode 付きで throw
 */
export async function createGmailDraft(
  input: CreateGmailDraftInput,
): Promise<CreateGmailDraftResult> {
  const { accessToken, to, subject, body, attachment } = input;

  if (!accessToken) {
    throw new GmailDraftError(
      "accessToken is required",
      "invalid_access_token",
      400,
    );
  }

  const raw = buildRawMimeMessage({ to, subject, body, attachment });

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

export const __internal = { encodeMimeHeader, generateBoundary, toBase64Url };
