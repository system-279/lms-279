/**
 * URL path 等から、レンダリング上は不可視な文字 (variation selector / zero-width / TAG 等) を除去する。
 *
 * Issue #456: macOS / iOS の入力履歴経由で `student` 末尾に U+FE0E が紛れ込み 404 になる事象。
 * 各範囲の意図は INVISIBLE_CHAR_PATTERN 内のインラインコメントを参照。
 * 通常絵文字 (U+1F300+) / CJK / 改行 / タブ / スペース は除去対象外。
 */

// no-misleading-character-class は VARIATION SELECTOR (U+FE00..U+FE0F) を combining mark とみなして
// 警告するが、本パターンは「単独で混入した VS を除去する」ことが目的で intentional。
// 既存の合字を破壊する用途ではないため、disable して character class に含める。
/* eslint-disable no-misleading-character-class */
const INVISIBLE_CHAR_PATTERN = new RegExp(
  "[" +
    "\\u00AD" + // soft hyphen
    "\\u200B-\\u200F" + // zero-width / LRM / RLM
    "\\u202A-\\u202E" + // bidi control (RLO による見せかけ攻撃)
    "\\u2060-\\u2064" + // word joiner / invisible operators
    "\\u2066-\\u206F" + // bidi isolates / deprecated formatting
    "\\uFE00-\\uFE0F" + // variation selectors 1-16 (Issue #456 の U+FE0E)
    "\\uFEFF" + // BOM / zero-width no-break space
    "]" +
    "|[\\u{E0000}-\\u{E007F}]" + // TAG characters (stego 対策)
    "|[\\u{E0100}-\\u{E01EF}]", // variation selectors supplement
  "gu",
);
/* eslint-enable no-misleading-character-class */

export function stripInvisibleChars(input: string): string {
  return input.replace(INVISIBLE_CHAR_PATTERN, "");
}

export function hasInvisibleChars(input: string): boolean {
  return input !== stripInvisibleChars(input);
}

/**
 * URL pathname (percent-encoded) を segment 単位で decode → 不可視文字除去 → re-encode する。
 *
 * 経路上の URL コンストラクタ (WHATWG URL / Next.js NextRequest) は不可視文字を percent-encode するため、
 * middleware に届く pathname は ASCII 化されている。素朴に全体 decode すると encoded path separator
 * (`%2F`) が真の `/` に化けて別 route に redirect される不可逆変換が起きるため、segment 単位で処理する。
 *
 * - 不正な percent sequence を含む segment はそのまま (decode 失敗を救済漏れに繋げず部分救済)
 * - 除去対象の不可視文字を含まない segment は original (再 encode 形式の揺れを避ける)
 */
export function sanitizeEncodedPathnameForRedirect(pathname: string): {
  needsRedirect: boolean;
  cleaned: string;
} {
  const cleaned = pathname
    .split("/")
    .map((segment) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch (err) {
        // 期待例外: URIError (malformed percent sequence)。部分救済のため original を
        // 返すが、observability のため warn を残す (Cloud Run logs に severity=WARNING で乗る)。
        // segment 本体は PII / 攻撃 payload 拡散リスクで出力しない。
        console.warn(
          "[sanitize-path] decodeURIComponent failed for segment",
          {
            segmentLength: segment.length,
            errorName: err instanceof Error ? err.name : "unknown",
          },
        );
        return segment;
      }
      const stripped = stripInvisibleChars(decoded);
      if (stripped === decoded) return segment;
      return encodeURIComponent(stripped);
    })
    .join("/");

  return { needsRedirect: cleaned !== pathname, cleaned };
}
