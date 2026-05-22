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
}

export interface BuiltCompletionMail {
  subject: string;
  /** 本文 (text/plain UTF-8)。改行は LF (MIME 側で CRLF に正規化される) */
  body: string;
}

/**
 * MIME ヘッダ系フィールドへの CRLF 注入を防ぐ defensive guard。
 *
 * 注意: gmail-dwd-send.ts の同名関数は **空文字 reject** も含むが、本関数では
 * 空文字ガードを意図的に持たない。理由: 本関数の caller (`buildCompletionMail`) は
 * userName を `normalizeUserName` で trim 後の長さチェックを通してから渡し、
 * subject は固定定数 `DEFAULT_COMPLETION_SUBJECT` を渡すため、空文字パスは
 * 本関数到達前に排除されている。空文字を許容しない上位制約があるため、本関数
 * 自体は CRLF 検出のみに責務を限定する (Single Responsibility)。
 */
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
  // signatureName は本文中に展開されるため MIME ヘッダ直接注入は発生しないが、
  // 受信側 (Gmail UI / Outlook) の表示で意図せぬ改行になるとフィッシング偽装等
  // に流用される懸念があるため、CRLF を含めれば throw する (本文 base64 化前に
  // 早期検出)。evaluator narrative 反映。
  if (signatureName.trim().length > 0) {
    assertHeaderSafe(signatureName, "signatureName");
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
