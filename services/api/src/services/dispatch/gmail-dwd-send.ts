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
 * 完了通知メールの raw MIME メッセージを base64url で返す。
 * Gmail API `users.messages.send` の raw フィールドに渡す形式。
 *
 * 添付なし固定 (Phase 3 仕様: 進捗 PDF は Phase 4+ で別途検討)。
 */
export function buildCompletionMime(input: BuildCompletionMimeInput): string {
  const { fromEmail, to, cc, subject, body } = input;

  assertHeaderSafe(fromEmail, "fromEmail");
  assertHeaderSafe(to, "to");
  assertHeaderSafe(subject, "subject");

  // Cc は配列、空なら Cc: 行を出さない (Phase 3 完了条件「CC validation 失敗時に
  // MIME に Cc: ヘッダが出ない」の構造保証)
  if (!Array.isArray(cc)) {
    throw new Error("gmail-dwd-send: cc must be an array");
  }
  for (const entry of cc) {
    assertHeaderSafe(entry, "cc[]");
  }
  const ccLines = cc.length > 0 ? [`Cc: ${cc.join(", ")}`] : [];

  const encodedSubject = encodeMimeHeader(subject);

  // 添付なしの text/plain メッセージ
  // 配列要素の `""` は join("\r\n") により空行 (ヘッダとボディ区切り、RFC 2822) になる
  const headerLines: string[] = [
    `From: ${fromEmail}`,
    `To: ${to}`,
    ...ccLines,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "", // ← ヘッダとボディの区切り空行 (RFC 2822 §2.1)
    Buffer.from(body, "utf-8").toString("base64"),
  ];
  const raw = headerLines.join("\r\n");
  return Buffer.from(raw, "utf-8").toString("base64url");
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
