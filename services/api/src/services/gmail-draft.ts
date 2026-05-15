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
  /**
   * RFC 6266 dual-form の ASCII fallback。filename が非 ASCII を含むときに
   * `filename="..."` の値として使われる。Gmail は filename*= を解釈せず
   * ASCII fallback を採用する経路があり、機械生成の `_` 連続では UUID に
   * フォールバックされるため、呼び出し側で意味のある ASCII 名 (email base 等)
   * を渡すこと。省略時は filename の非ASCII 文字を `_` に置換した自動 fallback。
   */
  asciiFallbackFilename?: string;
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
 * MIME ヘッダパラメータ (filename / name) を RFC 2231 / 5987 dual-form で組み立てる。
 *
 * RFC 2047 §5 により encoded-word (`=?UTF-8?B?...?=`) は MIME ヘッダ parameter value
 * で使用不可。非 ASCII は RFC 5987 `param*=UTF-8''<pct-encoded>` で表現し、古い
 * パーサ向けに ASCII fallback `param="..."` を併記する (RFC 6266 §5 dual-form)。
 *
 * Gmail は受信側で `filename*=` を解釈せず ASCII fallback を採用する経路があり、
 * 機械的な `_` 連続 fallback だと UUID にフォールバックされる。意味のある ASCII
 * fallback を呼び出し側から渡す `asciiOverride` 経路を用意し、未指定時のみ
 * `_` 置換のデフォルトを使う。
 *
 * 制御文字 (`\x00-\x1f`, `\x7f`) と lone surrogate は事前に呼び出し側 (assertSafeFilename)
 * で拒否する前提。本関数はそれら無効値が渡らないことを invariant として扱う。
 */
function buildFilenameParam(
  paramName: "filename" | "name",
  value: string,
  asciiOverride?: string,
): string {
  const isAscii = !/[^\x20-\x7e]/.test(value);
  if (isAscii) {
    // RFC 5322 quoted-pair: `\` も `"` も escape する
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${paramName}="${escaped}"`;
  }
  // 非 ASCII を `_` 化したデフォルト ASCII fallback (RFC 6266 §5 古いクライアント向け)
  const defaultFallback = value.replace(/[^\x20-\x7e]/g, "_");
  // asciiOverride が ASCII safe ならそれを使い、そうでなければデフォルトに退避
  const rawFallback =
    asciiOverride && !/[^\x20-\x7e]/.test(asciiOverride) ? asciiOverride : defaultFallback;
  const asciiFallback = rawFallback.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${paramName}="${asciiFallback}"; ${paramName}*=UTF-8''${rfc5987Encode(value)}`;
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
  const { to, subject, body, attachment } = input;

  // SECURITY: library 層でのヘッダインジェクション二重防御。
  // body 内の CR/LF は base64 エンコードされるため許容。
  assertNoCRLF(to, "to");
  assertNoCRLF(subject, "subject");
  if (attachment) {
    assertNoCRLF(attachment.filename, "attachment.filename");
    assertNoCRLF(attachment.contentType, "attachment.contentType");
    assertSafeFilename(attachment.filename);
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
  // RFC 2046 §5.1 の Content-Type `name=` は RFC 6266 で deprecated。一部 MUA は
  // Content-Disposition: filename を無視して Content-Type: name を優先するため、
  // ASCII fallback と filename* が両方マッチしないと UUID にフォールバックされる
  // 観測あり。name= を発行せず Content-Disposition: filename*= のみに統一する。
  const filenameParam = buildFilenameParam(
    "filename",
    attachment.filename,
    attachment.asciiFallbackFilename,
  );

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

export const __internal = {
  encodeMimeHeader,
  generateBoundary,
  toBase64Url,
  buildFilenameParam,
  rfc5987Encode,
  assertSafeFilename,
};
