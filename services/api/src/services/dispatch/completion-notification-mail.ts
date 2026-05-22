/**
 * DXcollege 自動完了通知の件名・本文を組み立てる純粋関数。
 *
 * 設計仕様書 §7.1 (Unit Test 観点)、FR-5 改訂、AC-5 に対応。
 *
 * 責務:
 *   - 件名 (subject) と本文 (body) を pure に組み立てる
 *   - 入力 (userName / completionMessageBody / signatureName) の CRLF を
 *     サニタイズ (MIME ヘッダインジェクション防止の二重防御、route 層も検証)
 *   - 文字数上限の超過は呼び出し側 (Phase 5 super-admin API) で検出する想定。
 *     本関数は組み立て pure 関数として責務を限定
 *
 * 非責務:
 *   - To/Cc の組み立て: gmail-dwd-send.ts 側で MIME ヘッダとして直接挿入
 *   - PII (受講者 email) のハッシュ化: Phase 4 reservation.ts で実施
 *
 * 件名の固定方針 (本 Phase での暫定):
 *   設計仕様書および DispatchSettings DTO には件名テンプレート field がない
 *   ため、Phase 1 / Phase 3 では **定数の件名** を使う。将来テナント別カスタマイズ
 *   要望が出たら DispatchSettings に subjectTemplate を追加して呼び出し側で
 *   override 可能にする想定 (本 Phase ではスコープ外、spec 未記載のため独断追加しない)。
 */

import type { CcEmailValidationFailure } from "./cc-email-validator.js";

/**
 * 完了通知メールの既定件名 (テナント・受講者横断で固定)。
 * 将来 settings に持たせるための export。
 */
export const DEFAULT_COMPLETION_SUBJECT = "【DXcollege】受講修了のお知らせ";

export interface BuildCompletionMailInput {
  /** 受講者名 (本文冒頭の宛名)。trim 後空文字なら「受講者各位」にフォールバック */
  userName: string | null | undefined;
  /** スーパー管理者が設定する本文 (DispatchSettings.completionMessageBody) */
  completionMessageBody: string;
  /** スーパー管理者が設定する署名 (DispatchSettings.signatureName) */
  signatureName: string;
  /**
   * 任意の CC validation 警告 (cc-email-validator から伝搬)。
   * UI / audit_logs 表示には使うが本文には混入しないため、本関数は受領のみで
   * 出力には影響しない (将来 audit log に同梱する際の引き渡し pass-through)。
   */
  ccValidationWarnings?: readonly CcEmailValidationFailure[];
}

export interface BuiltCompletionMail {
  subject: string;
  /** 本文 (text/plain UTF-8)。改行は LF (MIME 側で CRLF に正規化される) */
  body: string;
}

/** MIME ヘッダ系フィールドへの CRLF 注入を防ぐ defensive guard */
function assertHeaderSafe(value: string, fieldName: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(
      `completion-notification-mail: ${fieldName} contains CR/LF (header injection blocked)`,
    );
  }
}

function normalizeUserName(userName: string | null | undefined): string {
  if (typeof userName !== "string") return "";
  return userName.trim();
}

export function buildCompletionMail(
  input: BuildCompletionMailInput,
): BuiltCompletionMail {
  const { completionMessageBody, signatureName } = input;

  // ヘッダ系 (subject / userName) の CRLF 注入を library 層で阻止 (二重防御)。
  // body 内の CR/LF は base64 エンコードされるため許容するが、subject は MIME
  // ヘッダ行に直接乗るので reject する。
  assertHeaderSafe(DEFAULT_COMPLETION_SUBJECT, "subject");

  const normalizedName = normalizeUserName(input.userName);
  if (normalizedName.length > 0) {
    assertHeaderSafe(normalizedName, "userName");
  }

  // 本文組み立て: 宛名 + 設定本文 + 区切り + 署名 (空 signature は許容、行のみ追加しない)
  const greeting = normalizedName.length > 0 ? `${normalizedName} 様` : "受講者各位";
  const lines: string[] = [greeting, "", completionMessageBody.trimEnd()];
  if (signatureName.trim().length > 0) {
    lines.push("", "---", signatureName);
  }
  // 末尾に改行 1 行 (一般的なメール本文の見やすさ)
  lines.push("");

  return {
    subject: DEFAULT_COMPLETION_SUBJECT,
    body: lines.join("\n"),
  };
}
