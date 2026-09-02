import { createHash } from "node:crypto";

/**
 * エラーの同一性判定に使う fingerprint を計算する。
 * エラー名 + スタック先頭フレーム + 正規化メッセージ から sha256 を取る。
 */
export function computeFingerprint(
  errorName: string,
  firstStackFrame: string,
  normalizedMessage: string
): string {
  return createHash("sha256")
    .update(`${errorName}|${firstStackFrame}|${normalizedMessage}`)
    .digest("hex");
}

/** メッセージ中の可変値（数値・UUID）を潰し、似たメッセージを同一 fingerprint に丸める */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d+/g, "<n>")
    .trim();
}

/**
 * topStackFrames() の結果から、fingerprint 計算に使う「実際の呼び出しフレーム」の
 * 先頭行を取り出す。Node のスタックトレースは1行目が "TypeError: xxx" 等のヘッダ行
 * （エラーメッセージそのもの）で、2行目以降が "at ..." 形式の実フレームになる。
 * ヘッダ行は正規化前の生メッセージと同一のため、fingerprint にヘッダ行を使うと
 * normalizeMessage の効果が打ち消されてしまう（ID/件数が違うだけの同一エラーが
 * 毎回別 fingerprint になり、集約が効かなくなる）。
 */
export function firstStackFrameLine(stackFrames: string[]): string {
  const frame = stackFrames.find((line) => line.startsWith("at "));
  return frame ?? stackFrames[0] ?? "";
}
