/**
 * CC 配列の個別 validation + 重複排除を行う純粋関数。
 *
 * 設計仕様書 §3.x、FR-6、AC-4、AC-25 に対応。
 * Codex Important-6 反映: CC 配列を 1 要素ずつ validate し、不正要素は MIME に
 * 含めない (CRLF injection / MIME header smuggling 防止)。1 要素でも CRLF を含むと
 * 配列全体を拒否すると運用が硬直するため、不正要素のみ捨てて有効要素のみ採用する。
 *
 * 既存 progress-pdf-draft.ts の validateRecipientEmail と意図的に同じ判定ロジックを
 * 採用 (DRY)。将来的に common util へ抽出予定。
 *
 * 重複排除ポリシー:
 *   - case-insensitive で重複判定 (Gmail のローカル部は case-insensitive ではないが、
 *     現場運用で大文字小文字を間違えるケースを救う; RFC 5321 上は local-part が
 *     case-sensitive とされているが、ほぼ全 MTA が case-insensitive で動作する)
 *   - 先に登場した casing を保持する
 *   - 並び順: ownerEmail (有効なら) を先頭、その後 notificationCcEmails の入力順
 *   - ownerEmail と notificationCcEmails が同一 email を含む場合、ownerEmail を採用
 *     して notificationCcEmails 側は dedup される (AC-21 関連)
 *
 * 仕様書未記載のロジックを実装で独断追加することは AI 駆動開発 4 原則 §1 違反のため、
 * 上記ポリシーは設計仕様書 §3.x / FR-6 / AC-4 から派生する自然な解釈に限定する。
 */

export type CcEmailValidationReason =
  | "empty"
  | "crlf"
  | "comma"
  | "control"
  | "format";

export interface CcEmailValidationFailure {
  /** 元の入力値 (sanitize 前)。ログには出さない (PII)、UI エラー表示用 */
  input: string;
  reason: CcEmailValidationReason;
  /** owner / cc どちらの経路で発生したか (UI エラー表示用) */
  source: "owner" | "cc";
}

export interface ValidatedCcResult {
  /** dedup 後の有効 CC email 配列 (順序: ownerEmail 先頭、その後 notificationCcEmails 入力順) */
  validCcEmails: string[];
  /** validation で除外された要素一覧。空配列なら全件有効 */
  invalidEntries: CcEmailValidationFailure[];
}

/**
 * 単一 email の validation。
 * progress-pdf-draft.ts の validateRecipientEmail と同じロジック。
 *
 * - trim 後の空文字は "empty"
 * - 内部 CRLF は "crlf" (MIME ヘッダ注入防止)
 * - カンマは "comma" (複数宛先誤入力防止)
 * - C0 / DEL 制御文字は "control"
 * - 形式違反は "format" (Gmail 側が最終 validate)
 */
export function validateSingleEmail(
  input: unknown,
): { ok: true; value: string } | { ok: false; reason: CcEmailValidationReason } {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (/[\r\n]/.test(trimmed)) return { ok: false, reason: "crlf" };
  if (/,/.test(trimmed)) return { ok: false, reason: "comma" };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return { ok: false, reason: "control" };
  if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(trimmed)) {
    return { ok: false, reason: "format" };
  }
  return { ok: true, value: trimmed };
}

/**
 * CC 配列を個別 validate + 重複排除する。
 *
 * @param ccEmails 個別 validation 対象の CC 候補配列 (notificationCcEmails)
 * @param ownerEmail 先頭に追加する owner email (null なら追加しない)
 */
export function validateAndDedupeCcEmails(
  ccEmails: readonly string[],
  ownerEmail: string | null | undefined,
): ValidatedCcResult {
  const validCcEmails: string[] = [];
  const invalidEntries: CcEmailValidationFailure[] = [];
  /** dedup 用: lower-case email -> true */
  const seen = new Set<string>();

  // owner email を先に処理 (validCcEmails の先頭に配置するため)
  // null / undefined は AC-20 で許容されるため失敗扱いにしない (静かにスキップ)
  if (ownerEmail !== null && ownerEmail !== undefined) {
    const ownerResult = validateSingleEmail(ownerEmail);
    if (ownerResult.ok) {
      const key = ownerResult.value.toLowerCase();
      seen.add(key);
      validCcEmails.push(ownerResult.value);
    } else {
      invalidEntries.push({
        input: ownerEmail,
        reason: ownerResult.reason,
        source: "owner",
      });
    }
  }

  for (const raw of ccEmails) {
    const result = validateSingleEmail(raw);
    if (!result.ok) {
      invalidEntries.push({
        input: raw,
        reason: result.reason,
        source: "cc",
      });
      continue;
    }
    const key = result.value.toLowerCase();
    if (seen.has(key)) continue; // dedup
    seen.add(key);
    validCcEmails.push(result.value);
  }

  return { validCcEmails, invalidEntries };
}
