/**
 * URL path 等から、レンダリング上は不可視な文字 (variation selector / zero-width / TAG 等) を除去する。
 *
 * Issue #456: macOS / iOS の入力履歴経由で `student` 末尾に U+FE0E が紛れ込み 404 になる事象が発生。
 * 対象範囲:
 *   - U+00AD                  soft hyphen
 *   - U+200B..U+200F          zero-width / LRM / RLM
 *   - U+202A..U+202E          bidi control
 *   - U+2060..U+2064          word joiner / invisible operators
 *   - U+2066..U+206F          bidi isolates / deprecated formatting
 *   - U+FE00..U+FE0F          variation selectors 1-16
 *   - U+FEFF                  BOM / zero-width no-break space
 *   - U+E0000..U+E007F        TAG characters (stego 対策)
 *   - U+E0100..U+E01EF        variation selectors supplement
 *
 * 通常の絵文字 (U+1F300+) や CJK / 改行 / タブ等は除去対象外。
 */
// no-misleading-character-class は VARIATION SELECTOR (U+FE00..U+FE0F) を combining mark とみなして
// 警告するが、本パターンは「単独で混入した VS を除去する」ことが目的で intentional。
// 既存の合字を破壊する用途ではないため、disable して character class に含める。
/* eslint-disable no-misleading-character-class */
const INVISIBLE_CHAR_PATTERN = new RegExp(
  "[" +
    "\\u00AD" +
    "\\u200B-\\u200F" +
    "\\u202A-\\u202E" +
    "\\u2060-\\u2064" +
    "\\u2066-\\u206F" +
    "\\uFE00-\\uFE0F" +
    "\\uFEFF" +
    "]" +
    "|[\\u{E0000}-\\u{E007F}]" +
    "|[\\u{E0100}-\\u{E01EF}]",
  "gu",
);
/* eslint-enable no-misleading-character-class */

export function stripInvisibleChars(input: string): string {
  return input.replace(INVISIBLE_CHAR_PATTERN, "");
}

export function hasInvisibleChars(input: string): boolean {
  return input !== stripInvisibleChars(input);
}

export function sanitizePathForRedirect(pathname: string): {
  needsRedirect: boolean;
  cleaned: string;
} {
  const cleaned = stripInvisibleChars(pathname);
  return { needsRedirect: cleaned !== pathname, cleaned };
}
